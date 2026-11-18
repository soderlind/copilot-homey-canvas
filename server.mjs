import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DashboardError } from "./homey.mjs";

const assets = new Map([
    ["", ["index.html", "text/html; charset=utf-8"]],
    ["app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["style.css", ["style.css", "text/css; charset=utf-8"]],
]);

async function readJson(request) {
    if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new DashboardError("JSON content is required.", 415);
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 16384) throw new DashboardError("Request body is too large.", 413);
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
        if (error instanceof SyntaxError) throw new DashboardError("Invalid JSON.");
        throw error;
    }
}

export async function startServer(dashboard) {
    const token = randomBytes(24).toString("hex");
    const prefix = `/${token}/`;
    const streams = new Set();
    let origin;
    const unsubscribe = dashboard.subscribe((state) => {
        for (const stream of streams) stream.write(`data: ${JSON.stringify(state)}\n\n`);
    });
    const server = createServer(async (request, response) => {
        const json = (status, body) => {
            response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify(body));
        };
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'");
        try {
            if (request.headers.host !== new URL(origin).host ||
                (request.headers.origin && request.headers.origin !== origin)) {
                throw new DashboardError("Request origin is not allowed.", 403);
            }
            const pathname = new URL(request.url, origin).pathname;
            if (!pathname.startsWith(prefix)) throw new DashboardError("Not found.", 404);
            const route = pathname.slice(prefix.length);
            if (request.method === "GET" && assets.has(route)) {
                const [file, type] = assets.get(route);
                const content = await readFile(new URL(file, import.meta.url));
                response.writeHead(200, { "Content-Type": type });
                response.end(content);
            } else if (request.method === "GET" && route === "api/state") {
                json(200, dashboard.snapshot());
            } else if (request.method === "GET" && route === "api/events") {
                response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
                response.write(`data: ${JSON.stringify(dashboard.snapshot())}\n\n`);
                streams.add(response);
                response.on("close", () => streams.delete(response));
            } else if (request.method === "POST" && ["api/refresh", "api/action"].includes(route)) {
                if (request.headers["x-homey-canvas"] !== token) {
                    throw new DashboardError("Missing canvas request token.", 403);
                }
                const body = await readJson(request);
                json(200, route === "api/refresh" ? await dashboard.refresh() : await dashboard.act(body));
            } else {
                throw new DashboardError("Not found.", 404);
            }
        } catch (error) {
            if (!response.headersSent) json(error.status || 500, { error: error.message });
            else response.destroy(error);
        }
    });
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
    } catch (error) {
        unsubscribe();
        throw error;
    }
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        url: `${origin}${prefix}`,
        close: async () => {
            unsubscribe();
            for (const stream of streams) stream.end();
            streams.clear();
            await new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            });
        },
    };
}
