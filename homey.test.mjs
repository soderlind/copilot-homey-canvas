import test from "node:test";
import assert from "node:assert/strict";
import { HomeyDashboard, readCollection, runtimeCaller } from "./homey.mjs";
import { startServer } from "./server.mjs";

const success = (data) => ({ resultType: "success", textResultForLlm: JSON.stringify(data), structuredContent: data });

function fixture() {
    const data = {
        devices: [
            { id: "lamp", name: "Lamp", type: "light", zoneId: "room", state: { onoff: true, dim: 0.8 } },
            { id: "boiler", name: "Boiler", type: "boiler", state: { onoff: true } },
        ],
        zones: [{ id: "room", name: "Living room", parent: null }],
        flows: [{ id: "evening", name: "Evening", type: "advanced" }],
        moods: [{ id: "relax", name: "Relax" }],
    };
    const calls = [];
    const failures = new Map();
    const call = async (name, args) => {
        calls.push({ name, args });
        if (failures.has(name)) throw new Error(failures.get(name));
        if (name.startsWith("list_")) {
            const key = name.slice(5);
            return success({ [key]: structuredClone(data[key]) });
        }
        if (name === "set_devices_capabilities_values") {
            for (const [id, values] of Object.entries(args.state)) {
                Object.assign(data.devices.find((item) => item.id === id).state, values);
            }
        }
        return success({ success: true });
    };
    return { data, calls, failures, call, dashboard: new HomeyDashboard(call, { homeyId: "my-home" }) };
}

test("reads structured and textual Homey collections without hiding malformed responses", () => {
    const { data } = fixture();
    assert.deepEqual(readCollection(success({ devices: data.devices }), "devices"), data.devices);
    assert.deepEqual(readCollection(`Here's a list.\n\n${JSON.stringify(data.devices)}`, "devices"), data.devices);
    assert.deepEqual(readCollection(success({ moods: [] }), "moods"), []);
    assert.throws(() => readCollection(success({ result: "not a device list" }), "devices"), /unexpected/);
    assert.throws(() => readCollection({ resultType: "denied", textResultForLlm: "Permission denied" }, "devices"), /Permission denied/);
    assert.throws(() => readCollection(success({ devices: [{ id: "x", name: "x" }] }), "devices"), /unexpected/);
});

test("native integration selects the exact Homey server and preserves invocation errors", async () => {
    const calls = [];
    const session = { rpc: { tools: {
        getCurrentMetadata: async () => ({ tools: [
            { name: "unrelated", mcpServerName: "another-server", mcpToolName: "list_devices" },
            { name: "actual-homey-tool", mcpServerName: "homey", mcpToolName: "list_devices" },
        ] }),
        execute: async (args) => { calls.push(args); return success({ devices: [] }); },
    } } };
    const call = runtimeCaller(() => session, "homey");
    await call("list_devices", {});
    assert.deepEqual(calls, [{ name: "actual-homey-tool", arguments: {} }]);
    await assert.rejects(call("rename_device", {}), /Unsupported/);
    session.rpc.tools.execute = async () => ({ resultType: "denied", textResultForLlm: "Not approved" });
    await assert.rejects(call("list_devices", {}), /Not approved/);
    await assert.rejects(call("list_moods", {}), /unavailable/);
});

test("partial refresh retains stale data with explicit section errors", async () => {
    const { dashboard, failures, data } = fixture();
    await dashboard.refresh();
    failures.set("list_devices", "Homey authentication expired");
    data.flows.push({ id: "morning", name: "Morning", type: "standard" });
    const state = await dashboard.refresh();
    assert.equal(state.devices.length, 2);
    assert.equal(state.flows.length, 2);
    assert.equal(state.errors.devices, "Homey authentication expired");
    assert.equal(state.busy, false);
    failures.clear();
    assert.deepEqual((await dashboard.refresh()).errors, {});
});

test("only exact supported light capabilities can be changed", async () => {
    const { dashboard, calls } = fixture();
    const invalid = [
        { kind: "light", id: "boiler", capability: "onoff", value: false },
        { kind: "light", id: "lamp", capability: "dim", value: 1.1 },
        { kind: "light", id: "lamp", capability: "dim", value: -0.1 },
        { kind: "light", id: "lamp", capability: "dim", value: "0.5" },
        { kind: "light", id: "lamp", capability: "onoff", value: null },
        { kind: "light", id: "lamp", capability: "locked", value: false },
        { kind: "light", id: "missing", capability: "onoff", value: false },
    ];
    for (const input of invalid) await assert.rejects(dashboard.act(input));
    assert.equal(calls.filter((call) => !call.name.startsWith("list_")).length, 0);
    const result = await dashboard.act({ kind: "light", id: "lamp", capability: "dim", value: 0 });
    assert.equal(result.state.devices[0].state.dim, 0);
    assert.equal(result.warning, false);
    assert.deepEqual(calls.find((call) => call.name === "set_devices_capabilities_values").args, {
        homeyId: "my-home", state: { lamp: { dim: 0 } },
    });
});

test("Flows and Moods require confirmation and use authoritative IDs and Flow type", async () => {
    const { dashboard, calls } = fixture();
    await assert.rejects(dashboard.act({ kind: "flow", id: "evening" }), /Confirm/);
    await assert.rejects(dashboard.act({ kind: "mood", id: "relax" }), /Confirm/);
    assert.equal(calls.length, 0);
    await dashboard.act({ kind: "flow", id: "evening", confirmed: true, flowType: "standard" });
    await dashboard.act({ kind: "mood", id: "relax", confirmed: true });
    assert.deepEqual(calls.filter((call) => !call.name.startsWith("list_")), [
        { name: "start_flow", args: { homeyId: "my-home", flowId: "evening", flowType: "advanced" } },
        { name: "set_mood", args: { homeyId: "my-home", moodId: "relax" } },
    ]);
});

test("failed mutations are never retried or optimistically applied", async () => {
    const { dashboard, calls, failures } = fixture();
    failures.set("set_devices_capabilities_values", "Connection timed out");
    await assert.rejects(
        dashboard.act({ kind: "light", id: "lamp", capability: "onoff", value: false }),
        /not be retried automatically/,
    );
    assert.equal(calls.filter((call) => call.name === "set_devices_capabilities_values").length, 1);
    assert.equal(dashboard.snapshot().devices[0].state.onoff, true);
    assert.equal(dashboard.snapshot().busy, false);
});

test("an accepted command with a failed follow-up read is reported as unverified", async () => {
    const fixtureData = fixture();
    const dashboard = new HomeyDashboard(async (name, args) => {
        const result = await fixtureData.call(name, args);
        if (name === "set_devices_capabilities_values") fixtureData.failures.set("list_devices", "Offline");
        return result;
    });
    const result = await dashboard.act({ kind: "light", id: "lamp", capability: "onoff", value: false });
    assert.equal(result.warning, true);
    assert.match(result.message, /Status could not be refreshed/);
    assert.equal(result.state.errors.devices, "Offline");
});

test("simultaneous mutations cannot double-submit", async () => {
    const { dashboard, call, calls } = fixture();
    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    dashboard.call = async (name, args) => { await wait; return call(name, args); };
    const action = { kind: "flow", id: "evening", confirmed: true };
    const first = dashboard.act(action);
    await assert.rejects(dashboard.act(action), /already running/);
    release();
    await first;
    assert.equal(calls.filter((entry) => entry.name === "start_flow").length, 1);
});

test("loopback server protects data and action routes and serves the renderer", async (t) => {
    const { dashboard, calls } = fixture();
    const server = await startServer(dashboard);
    t.after(() => server.close());
    const origin = new URL(server.url).origin;
    const token = new URL(server.url).pathname.split("/")[1];
    assert.equal((await fetch(`${origin}/api/state`)).status, 404);
    assert.equal((await fetch(`${server.url}api/state`, { headers: { Origin: "https://example.com" } })).status, 403);
    assert.equal((await fetch(`${server.url}api/refresh`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).status, 403);
    assert.equal(calls.length, 0);
    const page = await fetch(server.url);
    assert.match(await page.text(), /Your home, at a glance/);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    const refreshed = await fetch(`${server.url}api/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Homey-Canvas": token, Origin: origin },
        body: "{}",
    });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).devices.length, 2);
    assert.equal((await fetch(`${server.url}app.js`)).status, 200);
    assert.equal((await fetch(`${server.url}style.css`)).status, 200);
});
