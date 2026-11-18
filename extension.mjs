import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { HomeyDashboard, runtimeCaller } from "./homey.mjs";
import { startServer } from "./server.mjs";

const servers = new Map();
const homes = new Map();
let session;

function getDashboard(instanceId) {
    const entry = servers.get(instanceId);
    if (!entry) throw new CanvasError("homey_not_open", "Open the Homey canvas first.");
    return entry.dashboard;
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "homey-dashboard",
            displayName: "Homey",
            description: "Homey device and room dashboard with light controls and confirmed Flow and Mood actions.",
            inputSchema: {
                type: "object",
                properties: {
                    serverName: { type: "string", minLength: 1, default: "homey" },
                    homeyId: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "refresh",
                    description: "Refresh devices, rooms, Flows, and Moods through Homey MCP without changing anything.",
                    inputSchema: { type: "object", properties: {}, additionalProperties: false },
                    handler: async (ctx) => {
                        let state;
                        try {
                            state = await getDashboard(ctx.instanceId).refresh();
                        } catch (error) {
                            throw new CanvasError("homey_refresh_failed", error.message);
                        }
                        if (Object.keys(state.errors).length) {
                            throw new CanvasError("homey_refresh_failed", JSON.stringify(state.errors));
                        }
                        return {
                            devices: state.devices.length, zones: state.zones.length,
                            flows: state.flows.length, moods: state.moods.length, updated: state.updated,
                        };
                    },
                },
                {
                    name: "get_state",
                    description: "Read the current dashboard snapshot, including timestamps and any connection errors.",
                    inputSchema: { type: "object", properties: {}, additionalProperties: false },
                    handler: (ctx) => getDashboard(ctx.instanceId).snapshot(),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    const { serverName = "homey", homeyId } = ctx.input || {};
                    const key = JSON.stringify([serverName, homeyId || null]);
                    let dashboard = homes.get(key);
                    if (!dashboard) {
                        // Homey owns durable device/Flow state; this is only a fresh-read cache.
                        dashboard = new HomeyDashboard(runtimeCaller(() => session, serverName), { serverName, homeyId });
                        homes.set(key, dashboard);
                    }
                    entry = { ...(await startServer(dashboard)), dashboard };
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Homey", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await entry.close();
                }
            },
        }),
    ],
});
