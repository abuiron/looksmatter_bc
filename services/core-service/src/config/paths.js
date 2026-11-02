import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Uploaded images are stored in, and served from, <core-service>/uploads, wherever
// the process was started from.
export const UPLOAD_DIR = path.resolve(__dirname, '../../uploads');
