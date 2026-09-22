import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import Logger from '../utils/Logger.js';

/**
 * Bootstraps the Express app, HTTP server, Socket.IO, and middleware.
 * @returns {{ app: import('express').Application, server: http.Server, io: Server }}
 */
export default function bootstrapServer() {
	const app = express();
	const server = http.createServer(app);

	// Socket.IO CORS is opt-in, not defaulted, on purpose: the client is served
	// from this same origin, so a default allowlist would break the local
	// workflow that exists today. When the deployment is exposed, CORS_ORIGINS
	// (comma separated) pins it. See plans/FIX-PLAN-2026-09.md T5.
	const corsOrigins = (process.env.CORS_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
	const io = new Server(server, corsOrigins.length
		? { cors: { origin: corsOrigins, credentials: true } }
		: {});

	const port = process.env.PORT || 3001;

	// Body limit: the world API takes ids and small JSON, and an unbounded body
	// turns any request into a memory event. Override only with a reason.
	app.use(express.json({ limit: process.env.MAX_BODY_LIMIT ?? '512kb' }));
	app.use(express.static('public'));
	// Serve shared browser-importable ES modules (e.g., /shared/RangeResolver.js)
	// so the client can import the SAME source of truth used by the server.
	// The shared/ folder lives at the project root (outside public/), so it is
	// mounted explicitly at /shared. An absolute path keeps this independent of
	// the process working directory (the server is launched from the root).
	app.use('/shared', express.static(path.resolve(process.cwd(), 'shared')));

	server.listen(port, () => {
		Logger.info('SlopSimulacrum Server running', {
			port,
			url: `http://localhost:${port}`,
		});

		if (process.env.REQUIRE_AUTH !== 'true') {
			Logger.warn('API is running without authentication (REQUIRE_AUTH != "true"). Local use only.');
		}
		if (!corsOrigins.length) {
			Logger.warn('Socket.IO CORS is unrestricted (CORS_ORIGINS unset). Set it before exposing the server.');
		}
	});

	return { app, server, io };
}