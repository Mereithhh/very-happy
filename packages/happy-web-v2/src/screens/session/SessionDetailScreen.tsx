import { useParams, useNavigate } from 'react-router-dom';
import { EmptyState, Button } from '@/ui';
// P3: full chat (ChatList/MessageView/AgentInput). Placeholder shows the session id.
export function SessionDetailScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <EmptyState
      title="Chat"
      description={`Session ${id} — chat UI lands in P3.`}
      actions={<Button onClick={() => navigate('/')}>Back</Button>}
    />
  );
}
