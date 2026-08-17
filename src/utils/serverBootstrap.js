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
	const io = new Server(server);

	const port = process.env.PORT || 3001;

	app.use(express.json());
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
	});

	return { app, server, io };
}