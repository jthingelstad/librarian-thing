import { handleAuthRequest } from '../auth/handler.mjs';
import { listen, makeServer } from './server.mjs';
listen(makeServer({ auth: handleAuthRequest }, 35));
