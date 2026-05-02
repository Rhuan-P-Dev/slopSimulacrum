import express from 'express';
import http from 'http';
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

	const port = process.env.PORT || 3000;

	app.use(express.json());
	app.use(express.static('public'));

	server.listen(port, () => {
		Logger.info('SlopSimulacrum Server running', {
			port,
			url: `http://localhost:${port}`,
		});
	});

	return { app, server, io };
}