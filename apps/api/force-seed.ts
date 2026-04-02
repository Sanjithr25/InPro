import 'dotenv/config';
import { ToolRegistry } from './src/engine/ToolRegistry.js';
ToolRegistry.seed()
  .then(() => { console.log('Seeding complete.'); process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });
