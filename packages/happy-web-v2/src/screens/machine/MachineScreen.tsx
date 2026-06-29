import { useParams, useNavigate } from 'react-router-dom';
import { EmptyState, Button } from '@/ui';
// P5: machine detail (status/daemon/sessions). Placeholder.
export function MachineScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <EmptyState
      title="Machine"
      description={`Machine ${id} — detail lands in P5.`}
      actions={<Button onClick={() => navigate('/')}>Back</Button>}
    />
  );
}
