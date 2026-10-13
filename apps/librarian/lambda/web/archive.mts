import { handleStreamRequest } from '../chat/runtime.mjs';
import { listen, makeServer } from './server.mjs';
listen(makeServer({ archive: handleStreamRequest }, 300));
