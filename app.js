const $ = (selector) => document.querySelector(selector);
const token = location.pathname.split("/")[1];
const formatNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
let state;
let tab = "devices";
let pendingConfirmation;
let submitting = false;

const labels = {
    onoff: ["Power", ""], dim: ["Brightness", "%"], measure_temperature: ["Temperature", "\u00b0C"],
    measure_humidity: ["Humidity", "%"], measure_battery: ["Battery", "%"],
    measure_power: ["Power", "W"], meter_power: ["Energy", "kWh"],
    measure_voltage: ["Voltage", "V"], measure_current: ["Current", "A"],
    measure_pressure: ["Pressure", "hPa"], measure_luminance: ["Light", "lx"],
    alarm_smoke: ["Smoke", ""], alarm_generic: ["Alarm", ""], alarm_motion: ["Motion", ""],
    alarm_contact: ["Contact", ""], alarm_water: ["Water alarm", ""],
    alarm_tamper: ["Tamper", ""], volume_set: ["Volume", "%"], speaker_playing: ["Playing", ""],
};

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function nameFor(key) {
    return labels[key]?.[0] || key.replace(/[_.]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function valueFor(key, value) {
    if (value === null || value === undefined) return "Not reported";
    if (typeof value === "boolean") {
        if (key === "onoff") return value ? "On" : "Off";
        if (key === "alarm_contact") return value ? "Open" : "Closed";
        if (key === "alarm_motion") return value ? "Detected" : "No motion";
        if (key.startsWith("alarm_")) return value ? "Active" : "Clear";
        return value ? "Yes" : "No";
    }
    if (typeof value === "number") {
        const scaled = ["dim", "volume_set"].includes(key) ? value * 100 : value;
        const unit = labels[key]?.[1];
        return `${formatNumber.format(scaled)}${unit ? ` ${unit}` : ""}`;
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function icon(type) {
    const paths = {
        light: "M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2",
        sensor: "M12 14a2 2 0 1 0 0 .1M7 17a7 7 0 0 1 0-10M17 7a7 7 0 0 1 0 10M4 20a11 11 0 0 1 0-16M20 4a11 11 0 0 1 0 16",
        smokealarm: "M12 3 2 21h20L12 3M12 9v5M12 17v1",
        speaker: "M5 3h14v18H5zM12 7h.01M16 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
        flow: "M4 4h6v6H4zM14 14h6v6h-6zM10 7h7v7",
        mood: "M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
        other: "M3 10 12 3l9 7v11h-7v-7h-4v7H3z",
    };
    const wrapper = node("span", "icon");
    wrapper.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[type] || paths.other);
    svg.append(path);
    wrapper.append(svg);
    return wrapper;
}

async function request(path, data) {
    const response = await fetch(`./api/${path}`, data === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Homey-Canvas": token },
        body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
}

function notice(text, warning = false) {
    $("#notice").hidden = !text;
    $("#notice").classList.toggle("warning", warning);
    $("#notice").textContent = text;
}

function blocked(key) {
    return submitting || state.busy || !state.updated[key] || Boolean(state.errors[key]);
}

function update(next) {
    state = next;
    render();
}

async function refresh() {
    notice("");
    try {
        update(await request("refresh", {}));
    } catch (error) {
        notice(`Refresh failed: ${error.message}`, true);
    }
}

async function act(input) {
    if (submitting) return;
    submitting = true;
    notice("Sending your request to Homey...");
    render();
    try {
        const result = await request("action", input);
        update(result.state);
        notice(result.message, result.warning);
    } catch (error) {
        notice(error.message, true);
    } finally {
        submitting = false;
        render();
    }
}

function confirmAction(item, kind) {
    pendingConfirmation = { kind, id: item.id, confirmed: true };
    $("#confirm-title").textContent = `${kind === "flow" ? "Run" : "Apply"} "${item.name}"?`;
    $("#confirm-description").textContent = kind === "flow" ?
        "This Flow may change multiple devices, including alarms or other equipment. Run it only if you know its effects." :
        "This Mood will change the lights included in the scene.";
    $("#confirm-run").textContent = kind === "flow" ? "Run Flow" : "Apply Mood";
    $("#confirm-dialog").showModal();
    $("#confirm-cancel").focus();
}

function cardHeading(item, type) {
    const top = node("div", "card-top");
    const heading = node("div", "card-heading");
    const text = node("div");
    text.append(node("h3", "", item.name), node("p", "device-type", type));
    heading.append(icon(item.type || type), text);
    top.append(heading);
    return top;
}

function deviceCard(device) {
    const values = device.state;
    const card = node("article", `card${device.type === "light" && values.onoff === true ? " light-on" : ""}`);
    const heading = cardHeading(device, device.type);
    const alarms = Object.entries(values).filter(([key, value]) =>
        key.startsWith("alarm_") && !["alarm_motion", "alarm_contact"].includes(key) && value === true
    );
    if (alarms.length) heading.append(node("span", "badge warning", "Active alert"));
    else if (typeof values.measure_battery === "number" && values.measure_battery <= 20) {
        heading.append(node("span", "badge warning", "Low battery"));
    }
    card.append(heading);
    const preferred = [
        "measure_temperature", "measure_humidity", "measure_power", "alarm_smoke", "alarm_motion",
        "alarm_contact", "measure_battery", "speaker_playing", "volume_set", "measure_price_total", "meter_price_sum",
    ];
    let keys = preferred.filter((key) => values[key] !== undefined && values[key] !== null).slice(0, 4);
    if (!keys.length) keys = Object.keys(values).filter((key) => values[key] !== null && !["dim", "onoff"].includes(key)).slice(0, 2);
    if (keys.length) {
        const metrics = node("dl", "metrics");
        for (const key of keys) {
            const metric = node("div");
            metric.append(node("dt", "", nameFor(key)), node("dd", "", valueFor(key, values[key])));
            metrics.append(metric);
        }
        card.append(metrics);
    }
    if (device.type === "light" && typeof values.onoff === "boolean") {
        const row = node("div", "control-row");
        const toggle = node("button", "switch");
        toggle.type = "button";
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-checked", String(values.onoff));
        toggle.setAttribute("aria-label", `Power for ${device.name}`);
        toggle.dataset.focusKey = `power-${device.id}`;
        toggle.disabled = blocked("devices");
        toggle.addEventListener("click", () => act({ kind: "light", id: device.id, capability: "onoff", value: !values.onoff }));
        row.append(node("span", "", values.onoff ? "On" : "Off"), toggle);
        card.append(row);
    } else if (typeof values.onoff === "boolean") {
        card.append(node("div", "muted", `Power: ${valueFor("onoff", values.onoff)} \u00b7 Status only`));
    }
    if (device.type === "light" && typeof values.dim === "number") {
        const brightness = node("div", "brightness");
        const label = node("label");
        const slider = node("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";
        slider.step = "1";
        slider.value = String(Math.round(values.dim * 100));
        slider.id = `dim-${device.id}`;
        slider.dataset.focusKey = slider.id;
        label.htmlFor = slider.id;
        const output = node("output", "", `${slider.value}%`);
        label.append(node("span", "", "Brightness"), output);
        slider.setAttribute("aria-label", `Brightness for ${device.name}`);
        slider.disabled = blocked("devices");
        slider.addEventListener("input", () => { output.textContent = `${slider.value}%`; });
        slider.addEventListener("change", () => act({
            kind: "light", id: device.id, capability: "dim", value: Number(slider.value) / 100,
        }));
        brightness.append(label, slider);
        card.append(brightness);
    }
    if (Object.keys(values).length) {
        const details = node("details", "readings");
        details.append(node("summary", "", "All readings"));
        const readings = node("dl", "reading-list");
        for (const [key, value] of Object.entries(values)) {
            readings.append(node("dt", "", nameFor(key)), node("dd", "", valueFor(key, value)));
        }
        details.append(readings);
        card.append(details);
    }
    return card;
}

function zonePath(zoneId) {
    const visited = new Set();
    const names = [];
    let current = state.zones.find((zone) => zone.id === zoneId);
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        names.unshift(current.name);
        current = state.zones.find((zone) => zone.id === current.parent);
    }
    return names.join(" / ");
}

function inZone(device, selected) {
    if (!selected) return true;
    const visited = new Set();
    let id = device.zoneId;
    while (id && !visited.has(id)) {
        if (id === selected) return true;
        visited.add(id);
        id = state.zones.find((zone) => zone.id === id)?.parent;
    }
    return false;
}

function renderContent() {
    if (!state) return;
    const active = document.activeElement?.dataset.focusKey;
    const content = $("#content");
    content.replaceChildren();
    content.setAttribute("aria-label", tab);
    content.setAttribute("aria-busy", String(state.busy));
    const search = $("#search").value.toLocaleLowerCase().trim();
    const items = state[tab].filter((item) =>
        `${item.name} ${item.zone || ""}`.toLocaleLowerCase().includes(search) &&
        (tab !== "devices" || inZone(item, $("#zone").value))
    );
    if (!items.length) {
        const empty = node("div", "empty");
        if (!state.updated[tab]) {
            empty.append(node("strong", "", state.errors[tab] ? `Could not load ${tab}` : `Loading ${tab}...`),
                node("span", "", state.errors[tab] ? "Check the connection error above, then refresh." : "Reading your Homey connection."));
        } else {
            empty.append(node("strong", "", search || (tab === "devices" && $("#zone").value) ? "No matches" : `No ${tab} configured`),
                node("span", "", search ? "Try another search." : tab === "moods" ? "Create a Mood in Homey and refresh to see it here." :
                    tab === "flows" ? "Homey lists only Flows that can be started." : "There are no devices in this view."));
        }
        content.append(empty);
        return;
    }
    if (tab === "devices") {
        const groups = new Map();
        for (const device of items) {
            const key = device.zoneId || "";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(device);
        }
        for (const [id, devices] of [...groups].sort(([a], [b]) => zonePath(a).localeCompare(zonePath(b)))) {
            const section = node("section", "room");
            const heading = node("div", "room-heading");
            heading.append(node("h2", "", zonePath(id) || devices[0].zone || "Unassigned"),
                node("span", "", String(devices.length)));
            const grid = node("div", "grid");
            devices.sort((a, b) => Number(b.type === "light") - Number(a.type === "light") || a.name.localeCompare(b.name));
            grid.append(...devices.map(deviceCard));
            section.append(heading, grid);
            content.append(section);
        }
    } else {
        const grid = node("div", "grid");
        for (const item of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
            const kind = tab === "flows" ? "flow" : "mood";
            const card = node("article", "card");
            card.append(cardHeading({ ...item, type: kind }, kind === "flow" ? `${item.type} Flow` : "Light scene"));
            const button = node("button", "button secondary routine-button", kind === "flow" ? "Run Flow" : "Apply Mood");
            button.type = "button";
            button.dataset.focusKey = `${kind}-${item.id}`;
            button.disabled = blocked(tab);
            button.addEventListener("click", () => confirmAction(item, kind));
            card.append(button);
            grid.append(card);
        }
        content.append(grid);
    }
    if (active) {
        [...content.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === active)?.focus({ preventScroll: true });
    }
}

function render() {
    if (!state) return;
    const errors = Object.entries(state.errors);
    const loaded = Object.keys(state.updated).length > 0;
    $("#connection").textContent = state.busy ? "Working in Homey..." :
        errors.length ? (loaded ? "Some data could not be refreshed" : "Homey connection needs attention") :
            loaded ? "Connected via Homey MCP" : "Ready to connect";
    $("#connection-dot").className = `dot ${state.busy ? "busy" : errors.length ? "error" : loaded ? "ready" : ""}`;
    const last = state.updated[tab];
    $("#updated").textContent = last ? `${errors.length ? "Last snapshot" : "Updated"} ${new Date(last).toLocaleTimeString()}` : "No snapshot yet";
    $("#refresh").disabled = state.busy || submitting;
    $("#refresh").textContent = state.busy ? "Working..." : "Refresh";
    $("#errors").replaceChildren(...errors.map(([key, error]) => node("p", "", `${nameFor(key)}: ${error}`)));
    $("#errors").hidden = !errors.length;
    const devices = state.devices;
    const activeAlerts = devices.filter((device) => Object.entries(device.state).some(([key, value]) =>
        key.startsWith("alarm_") && !["alarm_motion", "alarm_contact"].includes(key) && value === true
    )).length;
    const turnedOn = devices.filter((device) => device.state.onoff === true);
    const lightsOn = turnedOn.filter((device) => device.type === "light").length;
    const stats = [
        [devices.length, "Devices", false],
        [turnedOn.length, `Turned on \u00b7 ${lightsOn} light${lightsOn === 1 ? "" : "s"}`, false],
        [activeAlerts, "Devices with alerts", activeAlerts > 0],
        [devices.filter((device) => typeof device.state.measure_battery === "number" && device.state.measure_battery <= 20).length, "Low batteries", false],
    ];
    $("#summary").replaceChildren(...stats.map(([value, label, alert]) => {
        const card = node("div", `stat${alert ? " alert" : ""}`);
        card.append(node("span", "stat-value", state.updated.devices ? String(value) : "\u2014"), node("span", "stat-label", label));
        return card;
    }));
    for (const key of ["devices", "flows", "moods"]) $(`#count-${key}`).textContent = String(state[key].length);
    const zone = $("#zone");
    const selected = zone.value;
    zone.replaceChildren(node("option", "", "All rooms"));
    zone.firstChild.value = "";
    for (const item of [...state.zones].sort((a, b) => zonePath(a.id).localeCompare(zonePath(b.id)))) {
        const option = node("option", "", zonePath(item.id));
        option.value = item.id;
        zone.append(option);
    }
    zone.value = [...zone.options].some((option) => option.value === selected) ? selected : "";
    $("#zone-label").hidden = tab !== "devices";
    renderContent();
}

$("#refresh").addEventListener("click", refresh);
$("#search").addEventListener("input", renderContent);
$("#zone").addEventListener("change", renderContent);
for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => {
        tab = button.dataset.tab;
        for (const other of document.querySelectorAll("[data-tab]")) {
            other.classList.toggle("selected", other === button);
            other.setAttribute("aria-pressed", String(other === button));
        }
        $("#search").value = "";
        render();
    });
}
$("#confirm-cancel").addEventListener("click", () => {
    pendingConfirmation = undefined;
    $("#confirm-dialog").close();
});
$("#confirm-dialog").addEventListener("cancel", () => { pendingConfirmation = undefined; });
$("#confirm-run").addEventListener("click", () => {
    const input = pendingConfirmation;
    pendingConfirmation = undefined;
    $("#confirm-dialog").close();
    if (input) act(input);
});

try {
    update(await request("state"));
    const events = new EventSource("./api/events");
    events.onmessage = (event) => {
        try {
            update(JSON.parse(event.data));
        } catch (error) {
            notice(`Could not read dashboard updates: ${error.message}`, true);
        }
    };
    events.onerror = () => notice("Dashboard updates disconnected. Waiting to reconnect; refresh if this persists.", true);
    window.addEventListener("pagehide", () => events.close(), { once: true });
    if (!state.lastAttempt && !state.busy) await refresh();
} catch (error) {
    $("#connection").textContent = "Could not connect to the dashboard";
    notice(error.message, true);
}
