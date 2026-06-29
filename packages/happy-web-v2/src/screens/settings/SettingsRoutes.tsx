import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { ItemList, ItemGroup, Item, Button } from '@/ui';
import { useTheme } from '@/ui';
// P5: full settings tree. Placeholder: theme + logout so the shell is usable.
export function SettingsRoutes() {
  const { logout } = useAuth();
  const { preference, setPreference } = useTheme();
  const navigate = useNavigate();
  return (
    <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <ItemList>
        <ItemGroup title="Appearance">
          {(['system', 'dark', 'light'] as const).map((p) => (
            <Item key={p} title={p} selected={preference === p} onClick={() => setPreference(p)} />
          ))}
        </ItemGroup>
        <ItemGroup title="Account">
          <Item title="Log out" destructive onClick={() => logout()} />
        </ItemGroup>
      </ItemList>
      <div style={{ marginTop: 16 }}>
        <Button onClick={() => navigate('/')}>Back</Button>
      </div>
    </div>
  );
}
