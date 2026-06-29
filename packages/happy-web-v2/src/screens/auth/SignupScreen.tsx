import { useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '@/ui';
import { CyberBackdrop } from '@/screens/common/CyberBackdrop';
// P5: full signup (username/password/invite). Placeholder routes back to login.
export function SignupScreen() {
  const navigate = useNavigate();
  return (
    <div className="auth-page">
      <CyberBackdrop />
      <EmptyState
        title="Create account"
        description="Sign-up UI lands in P5."
        actions={<Button onClick={() => navigate('/login')}>Back to sign in</Button>}
      />
    </div>
  );
}
