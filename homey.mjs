const sections = ["devices", "zones", "flows", "moods"];
const allowedTools = new Set([
    ...sections.map((key) => `list_${key}`),
    "set_devices_capabilities_values",
    "start_flow",
    "set_mood",
]);

export class DashboardError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkResult(result) {
    if (typeof result === "string") return result;
    if (!isObject(result)) throw new DashboardError("Homey returned an invalid response.", 502);
    if (result.resultType !== "success") {
        throw new DashboardError(
            result.error || result.textResultForLlm || `Homey request ${result.resultType}.`,
            502,
        );
    }
    if (result.structuredContent?.isError === true || result.structuredContent?.success === false) {
        throw new DashboardError(result.textResultForLlm || "Homey reported an error.", 502);
    }
    return result;
}

export function readCollection(result, key) {
    checkResult(result);
    let rows = isObject(result) ? result.structuredContent?.[key] : undefined;
    if (!Array.isArray(rows)) {
        const text = typeof result === "string" ? result : result.textResultForLlm;
        // Homey also supplies JSON on its own line after a human-readable introduction.
        for (const candidate of [text, ...(text || "").split("\n")]) {
            if (!candidate?.trim().match(/^[{[]/)) continue;
            let parsed;
            try {
                parsed = JSON.parse(candidate);
            } catch (error) {
                if (error instanceof SyntaxError) continue;
                throw error;
            }
            const collection = Array.isArray(parsed) ? parsed : parsed?.[key];
            if (Array.isArray(collection)) {
                rows = collection;
                break;
            }
        }
    }
    if (!Array.isArray(rows) || rows.some((row) =>
        !isObject(row) || typeof row.id !== "string" || !row.id ||
        typeof row.name !== "string" ||
        (key === "devices" && (!isObject(row.state) || typeof row.type !== "string")) ||
        (key === "flows" && !["standard", "advanced"].includes(row.type))
    )) {
        throw new DashboardError(`Homey returned an unexpected ${key} response. No data was replaced.`, 502);
    }
    return rows;
}

export function runtimeCaller(getSession, serverName) {
    return async (toolName, args) => {
        if (!allowedTools.has(toolName)) throw new DashboardError("Unsupported Homey operation.");
        const session = getSession();
        if (!session) throw new DashboardError("Copilot is still connecting. Refresh shortly.", 503);
        let metadata = await session.rpc.tools.getCurrentMetadata();
        if (metadata.tools === null) {
            await session.rpc.tools.initializeAndValidate();
            metadata = await session.rpc.tools.getCurrentMetadata();
        }
        const tool = metadata.tools?.find((item) =>
            item.mcpServerName === serverName && item.mcpToolName === toolName
        );
        if (!tool) {
            throw new DashboardError(
                `The "${serverName}" MCP tool "${toolName}" is unavailable. Check this server in Customize > Installed. If authentication is required, choose Sign in, then refresh.`,
                503,
            );
        }
        // Use the native invocation pipeline; authentication and permissions stay with Copilot.
        return checkResult(await session.rpc.tools.execute({ name: tool.name, arguments: args }));
    };
}

export class HomeyDashboard {
    constructor(call, { homeyId, serverName = "homey" } = {}) {
        this.call = call;
        this.args = homeyId ? { homeyId } : {};
        this.listeners = new Set();
        this.state = {
            serverName,
            homeyId: homeyId || null,
            devices: [], zones: [], flows: [], moods: [],
            updated: {}, errors: {}, busy: false, lastAttempt: null,
        };
    }

    snapshot() {
        return structuredClone(this.state);
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    publish() {
        for (const listener of this.listeners) listener(this.snapshot());
    }

    async load(key) {
        try {
            const result = await this.call(`list_${key}`, this.args);
            this.state[key] = readCollection(result, key);
            this.state.updated[key] = new Date().toISOString();
            delete this.state.errors[key];
        } catch (error) {
            this.state.errors[key] = error.message;
            throw error;
        }
    }

    async exclusive(operation) {
        if (this.state.busy) throw new DashboardError("A Homey request is already running. Please wait.", 409);
        this.state.busy = true;
        this.state.lastAttempt = new Date().toISOString();
        this.publish();
        try {
            return await operation();
        } finally {
            this.state.busy = false;
            this.publish();
        }
    }

    async refresh() {
        await this.exclusive(async () => {
            // A failed section remains visibly stale without discarding other successful reads.
            await Promise.allSettled(sections.map((key) => this.load(key)));
        });
        return this.snapshot();
    }

    async act(input) {
        if (!isObject(input) || typeof input.id !== "string" || !input.id) {
            throw new DashboardError("An exact device, Flow, or Mood ID is required.");
        }
        if (!["light", "flow", "mood"].includes(input.kind)) {
            throw new DashboardError("Unsupported dashboard action.");
        }
        if (input.kind !== "light" && input.confirmed !== true) {
            throw new DashboardError("Confirm this action in the dashboard before running it.");
        }
        let message;
        let warning = false;
        await this.exclusive(async () => {
            const key = { light: "devices", flow: "flows", mood: "moods" }[input.kind];
            await this.load(key);
            const item = this.state[key].find((row) => row.id === input.id);
            if (!item) throw new DashboardError("This item is no longer available in Homey.", 404);
            let tool;
            let args;
            if (input.kind === "light") {
                const validValue =
                    (input.capability === "onoff" && typeof input.value === "boolean") ||
                    (input.capability === "dim" && typeof input.value === "number" &&
                        Number.isFinite(input.value) && input.value >= 0 && input.value <= 1);
                if (item.type !== "light" || !validValue ||
                    !Object.hasOwn(item.state, input.capability) || item.state[input.capability] === null) {
                    throw new DashboardError("Only supported light on/off and brightness controls are allowed.");
                }
                tool = "set_devices_capabilities_values";
                args = { ...this.args, state: { [item.id]: { [input.capability]: input.value } } };
            } else if (input.kind === "flow") {
                tool = "start_flow";
                args = { ...this.args, flowId: item.id, flowType: item.type };
            } else {
                tool = "set_mood";
                args = { ...this.args, moodId: item.id };
            }
            try {
                checkResult(await this.call(tool, args));
            } catch (error) {
                throw new DashboardError(
                    `Homey did not confirm the action: ${error.message} Refresh device status before retrying; the request will not be retried automatically.`,
                    502,
                );
            }
            message = input.kind === "flow" ? `Start requested for "${item.name}".` :
                input.kind === "mood" ? `Mood requested: "${item.name}".` :
                    `Light update sent to "${item.name}".`;
            try {
                await this.load("devices");
                if (input.kind === "light") {
                    const actual = this.state.devices.find((row) => row.id === item.id)?.state[input.capability];
                    const matches = input.capability === "dim" ?
                        typeof actual === "number" && Math.abs(actual - input.value) < 0.011 :
                        actual === input.value;
                    if (!matches) {
                        message += " The device has not reported the requested value yet. Refresh shortly.";
                        warning = true;
                    }
                }
            } catch (error) {
                message += ` Status could not be refreshed: ${error.message}`;
                warning = true;
            }
        });
        return { message, warning, state: this.snapshot() };
    }
}
