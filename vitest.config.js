import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    // Vite forbids importing JS files that live under its `public/` asset
    // directory; the client sources ARE under public/ and the tests must
    // import them, so disable the static-public handling for the test env.
    publicDir: false,
    // Client modules import their utilities with ABSOLUTE browser paths
    // (e.g. `import ClientLogger from '/utils/ClientLogger.js'`). The alias
    // maps that prefix onto the public/ directory so client-side controllers
    // (Feature D: RoomChatController smoke test) can be imported from
    // node-environment tests.
    resolve: {
        alias: {
            '/utils': fileURLToPath(new URL('./public/utils', import.meta.url))
        }
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'test/',
                'plans/',
            ],
        },
    },
});
