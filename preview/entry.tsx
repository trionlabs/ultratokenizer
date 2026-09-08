import { createRoot } from 'react-dom/client';
import BlueprintWorkspace from '../components/blueprint/workspace';
const root = document.getElementById('root');
if (!root) throw new Error('Missing blueprint root element');
createRoot(root).render(<BlueprintWorkspace />);
