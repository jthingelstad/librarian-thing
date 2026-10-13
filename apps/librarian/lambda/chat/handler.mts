import { handleStreamRequest } from './runtime.mjs';
import type { LibrarianHttpEvent } from '../shared/http.mjs';
export const handler = awslambda.streamifyResponse<LibrarianHttpEvent>(handleStreamRequest);
