import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BadgeCheck,
  Bell,
  Boxes,
  Check,
  ChevronRight,
  Clipboard,
  Clock3,
  Copy,
  DatabaseBackup,
  Eye,
  EyeOff,
  FolderPlus,
  Gamepad2,
  History,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogIn,
  LogOut,
  Moon,
  Plus,
  Save,
  Search,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  UserCog,
  Users,
  X
} from 'lucide-react';
import { api, DISCORD_LOGIN_URL, formatDate } from './api.js';

const emptyForm = {
  name: '',
  login: '',
  password: '',
  platform: 'Roblox',
  photoUrl: '',
  notes: '',
  robloxUsername: ''
};

const platformOptions = ['Roblox', 'Discord', 'Steam', 'Epic Games', 'Google', 'Microsoft', 'Outro'];

const historyLabels = {
  created: 'Conta criada',
  updated: 'Conta alterada',
  deleted: 'Conta removida',
  shared: 'Compartilhamento criado',
  share_removed: 'Compartilhamento removido'
};

const errorLabels = {
  unauthorized: 'Seu Discord ID nao esta autorizado.',
  blocked: 'Acesso bloqueado temporariamente por tentativas invalidas.',
  invalid_state: 'A sessao de login expirou.',
  missing_code: 'O Discord nao retornou o codigo OAuth2.',
  oauth_config: 'Configuracao do Discord OAuth2 incompleta. Confira o Client ID e o redirect no .env.',
  oauth_redirect: 'Redirect URL diferente entre Discord e .env.',
  oauth_user: 'Discord autorizou, mas nao foi possivel ler seu perfil.',
  oauth: 'Nao foi possivel concluir o login com Discord.'
};

function initials(name = 'N') {
  return name.slice(0, 2).toUpperCase();
}

function Avatar({ src, name, size = 'md' }) {
  return (
    <div className={`avatar avatar-${size}`}>
      {src ? <img src={src} alt="" /> : <span>{initials(name)}</span>}
    </div>
  );
}

function IconButton({ label, children, className = '', ...props }) {
  return (
    <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

function LoginScreen() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');

  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="brand-mark">
          <ShieldCheck size={34} />
        </div>
        <div>
          <p className="eyebrow">Nexus</p>
          <h1>Cofre privado de contas</h1>
          <p className="muted">Acesso exclusivo por Discord OAuth2 e whitelist.</p>
        </div>
        {error && <div className="notice danger">{errorLabels[error] || 'Login recusado.'}</div>}
        <a className="primary-button login-button" href={DISCORD_LOGIN_URL}>
          <LogIn size={20} />
          Entrar com Discord
        </a>
      </section>
    </main>
  );
}

function Shell({ user, theme, onToggleTheme, onLogout, view, setView, children }) {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'accounts', label: 'Cofre', icon: KeyRound },
    { id: 'images', label: 'Imagens', icon: ImageIcon },
    { id: 'history', label: 'Historico', icon: History },
    { id: 'users', label: 'Usuarios', icon: Users, admin: true },
    { id: 'settings', label: 'Ajustes', icon: Settings },
    { id: 'profile', label: 'Perfil', icon: UserCog }
  ].filter((item) => !item.admin || ['owner', 'admin'].includes(user.role));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="sidebar-brand" onClick={() => setView('dashboard')}>
          <span className="brand-mark compact"><ShieldCheck size={23} /></span>
          <span>Nexus</span>
        </button>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? 'active' : ''}
                onClick={() => setView(item.id)}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button className="user-chip" onClick={() => setView('profile')}>
            <Avatar src={user.avatarUrl} name={user.globalName || user.username} />
            <span>
              <strong>{user.globalName || user.username}</strong>
              <small>{user.role}</small>
            </span>
          </button>
          <div className="footer-actions">
            <IconButton label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'} onClick={onToggleTheme}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </IconButton>
            <IconButton label="Sair" onClick={onLogout}>
              <LogOut size={18} />
            </IconButton>
          </div>
        </div>
      </aside>
      <main className="content">{children}</main>
      <nav className="mobile-nav">
        {navItems.slice(0, 5).map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function PageHeader({ eyebrow, title, actions }) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

function Dashboard({ accounts, history, setView, setSelectedAccount }) {
  const owned = accounts.filter((account) => account.permission === 'owner').length;
  const shared = accounts.length - owned;
  const roblox = accounts.filter((account) => account.platform.toLowerCase() === 'roblox').length;
  const lastUpdated = accounts[0]?.updatedAt;

  return (
    <section className="page">
      <PageHeader
        eyebrow="Visao geral"
        title="Dashboard"
        actions={<button className="primary-button" onClick={() => setView('accounts')}><Plus size={18} /> Nova conta</button>}
      />
      <div className="metric-grid">
        <Metric icon={KeyRound} label="Contas no cofre" value={accounts.length} />
        <Metric icon={Shield} label="Criadas por voce" value={owned} />
        <Metric icon={Share2} label="Compartilhadas" value={shared} />
        <Metric icon={Gamepad2} label="Roblox" value={roblox} />
      </div>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-title">
            <h3>Atualizadas recentemente</h3>
            <Clock3 size={18} />
          </div>
          <div className="account-stack">
            {accounts.slice(0, 5).map((account) => (
              <button
                key={account.id}
                className="account-row"
                onClick={() => {
                  setSelectedAccount(account);
                  setView('details');
                }}
              >
                <Avatar src={account.roblox?.avatarUrl || account.photoUrl} name={account.name} />
                <span>
                  <strong>{account.name}</strong>
                  <small>{account.platform} · {formatDate(account.updatedAt)}</small>
                </span>
                <ChevronRight size={18} />
              </button>
            ))}
            {accounts.length === 0 && <EmptyState icon={KeyRound} title="Nenhuma conta ainda" />}
          </div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <h3>Atividade</h3>
            <Activity size={18} />
          </div>
          <Timeline history={history.slice(0, 6)} />
        </section>
      </div>
      <div className="status-strip">
        <span><ShieldCheck size={17} /> AES-256-GCM ativo</span>
        <span><Lock size={17} /> Cookie HTTP-only</span>
        <span><DatabaseBackup size={17} /> Backup criptografado</span>
        <span><Bell size={17} /> Ultima alteracao: {formatDate(lastUpdated)}</span>
      </div>
    </section>
  );
}

function Metric({ icon: Icon, label, value }) {
  return (
    <article className="metric-card">
      <Icon size={21} />
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function EmptyState({ icon: Icon, title }) {
  return (
    <div className="empty-state">
      <Icon size={28} />
      <strong>{title}</strong>
    </div>
  );
}

function AccountsPage({ accounts, filters, setFilters, onCreate, onEdit, onOpen }) {
  const platforms = useMemo(() => {
    const unique = new Set(accounts.map((account) => account.platform));
    return Array.from(unique).sort();
  }, [accounts]);

  return (
    <section className="page">
      <PageHeader
        eyebrow="Cofre de contas"
        title="Lista de contas"
        actions={<button className="primary-button" onClick={onCreate}><Plus size={18} /> Adicionar</button>}
      />
      <div className="toolbar">
        <label className="search-box">
          <Search size={18} />
          <input
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
            placeholder="Pesquisar por nome, login ou plataforma"
          />
        </label>
        <label className="select-box">
          <SlidersHorizontal size={18} />
          <select
            value={filters.platform}
            onChange={(event) => setFilters((current) => ({ ...current, platform: event.target.value }))}
          >
            <option value="">Todas</option>
            {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
          </select>
        </label>
      </div>
      <div className="account-grid">
        {accounts.map((account) => (
          <AccountCard key={account.id} account={account} onEdit={onEdit} onOpen={onOpen} />
        ))}
      </div>
      {accounts.length === 0 && <EmptyState icon={Search} title="Nada encontrado" />}
    </section>
  );
}

function AccountCard({ account, onEdit, onOpen }) {
  const isRoblox = account.platform.toLowerCase() === 'roblox';

  return (
    <article className="account-card">
      <button className="account-main" onClick={() => onOpen(account)}>
        <Avatar src={account.roblox?.avatarUrl || account.photoUrl} name={account.name} size="lg" />
        <span>
          <strong>{account.name}</strong>
          <small>{account.login || 'Sem usuario'}</small>
        </span>
      </button>
      <div className="tag-line">
        <span className={isRoblox ? 'tag roblox' : 'tag'}>
          {isRoblox ? <Gamepad2 size={15} /> : <Boxes size={15} />}
          {account.platform}
        </span>
        {account.permission !== 'owner' && <span className="tag"><Share2 size={15} /> {account.permission}</span>}
      </div>
      {account.roblox && (
        <div className="roblox-mini">
          <span>{account.roblox.username}</span>
          <small>{account.roblox.displayName}</small>
        </div>
      )}
      <div className="card-actions">
        <IconButton label="Copiar usuario" onClick={() => copyText(account.login)}>
          <Copy size={17} />
        </IconButton>
        {account.canEdit && (
          <IconButton label="Editar" onClick={() => onEdit(account)}>
            <Save size={17} />
          </IconButton>
        )}
        <button className="text-button" onClick={() => onOpen(account)}>
          Detalhes
        </button>
      </div>
    </article>
  );
}

function AccountDetails({ account, onBack, onEdit, onRefresh, onDeleted }) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [history, setHistory] = useState([]);
  const [shares, setShares] = useState([]);
  const [shareForm, setShareForm] = useState({ discordId: '', permission: 'view' });
  const [message, setMessage] = useState('');

  const loadDetails = useCallback(async () => {
    const historyPayload = await api(`/accounts/${account.id}/history`);
    setHistory(historyPayload.history);
    if (account.canShare) {
      const sharesPayload = await api(`/accounts/${account.id}/shares`);
      setShares(sharesPayload.shares);
    }
  }, [account.id, account.canShare]);

  useEffect(() => {
    setPassword('');
    setVisible(false);
    loadDetails().catch((error) => setMessage(error.message));
  }, [loadDetails]);

  async function revealPassword() {
    if (visible) {
      setVisible(false);
      return;
    }
    const payload = await api(`/accounts/${account.id}/secret/password`);
    setPassword(payload.password);
    setVisible(true);
  }

  async function saveShare(event) {
    event.preventDefault();
    await api(`/accounts/${account.id}/shares`, { method: 'PUT', body: shareForm });
    setShareForm({ discordId: '', permission: 'view' });
    setMessage('Compartilhamento salvo.');
    await loadDetails();
  }

  async function removeShare(discordId) {
    await api(`/accounts/${account.id}/shares/${discordId}`, { method: 'DELETE' });
    setMessage('Acesso removido.');
    await loadDetails();
  }

  async function deleteAccount() {
    const confirmed = window.confirm('Remover esta conta do cofre?');
    if (!confirmed) return;
    await api(`/accounts/${account.id}`, { method: 'DELETE' });
    onDeleted();
  }

  return (
    <section className="page">
      <PageHeader
        eyebrow="Detalhes da conta"
        title={account.name}
        actions={
          <>
            <button className="ghost-button" onClick={onBack}>Voltar</button>
            {account.canEdit && <button className="primary-button" onClick={() => onEdit(account)}><Save size={18} /> Editar</button>}
          </>
        }
      />
      {message && <div className="notice">{message}</div>}
      <div className="details-layout">
        <section className="panel hero-account">
          <Avatar src={account.roblox?.avatarUrl || account.photoUrl} name={account.name} size="xl" />
          <div>
            <div className="tag-line">
              <span className={account.platform.toLowerCase() === 'roblox' ? 'tag roblox' : 'tag'}>
                {account.platform.toLowerCase() === 'roblox' ? <Gamepad2 size={15} /> : <Boxes size={15} />}
                {account.platform}
              </span>
              <span className="tag"><Shield size={15} /> {account.permission}</span>
            </div>
            <h3>{account.name}</h3>
            <p className="muted">{account.notes || 'Sem observacoes.'}</p>
          </div>
        </section>

        <section className="panel secret-panel">
          <div className="field-row">
            <span>Usuario/Login</span>
            <strong>{account.login || 'Nao informado'}</strong>
            <IconButton label="Copiar usuario" onClick={() => copyText(account.login)}>
              <Copy size={17} />
            </IconButton>
          </div>
          <div className="field-row">
            <span>Senha</span>
            <strong>{visible ? password : '************'}</strong>
            <IconButton label={visible ? 'Ocultar senha' : 'Mostrar senha'} onClick={revealPassword}>
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
            </IconButton>
            <IconButton label="Copiar senha" onClick={async () => {
              const value = visible ? password : (await api(`/accounts/${account.id}/secret/password`)).password;
              copyText(value);
            }}>
              <Clipboard size={17} />
            </IconButton>
          </div>
          <div className="date-grid">
            <span>Criada em <strong>{formatDate(account.createdAt)}</strong></span>
            <span>Alterada em <strong>{formatDate(account.updatedAt)}</strong></span>
          </div>
        </section>

        {account.roblox && (
          <section className="panel roblox-panel">
            <div className="panel-title">
              <h3>Roblox</h3>
              <BadgeCheck size={18} />
            </div>
            <div className="roblox-profile">
              <Avatar src={account.roblox.avatarUrl} name={account.roblox.username} size="lg" />
              <span>
                <strong>{account.roblox.username}</strong>
                <small>{account.roblox.displayName}</small>
              </span>
              <a className="text-button" href={account.roblox.profileUrl} target="_blank" rel="noreferrer">Perfil</a>
            </div>
            <div className="field-row compact">
              <span>UserId</span>
              <strong>{account.roblox.userId}</strong>
            </div>
          </section>
        )}

        {account.canShare && (
          <section className="panel share-panel">
            <div className="panel-title">
              <h3>Compartilhamento</h3>
              <Share2 size={18} />
            </div>
            <form className="share-form" onSubmit={saveShare}>
              <input
                value={shareForm.discordId}
                onChange={(event) => setShareForm((current) => ({ ...current, discordId: event.target.value }))}
                placeholder="Discord ID autorizado"
                required
              />
              <select
                value={shareForm.permission}
                onChange={(event) => setShareForm((current) => ({ ...current, permission: event.target.value }))}
              >
                <option value="view">Apenas visualizar</option>
                <option value="edit">Visualizar e editar</option>
              </select>
              <button className="primary-button"><Share2 size={17} /> Compartilhar</button>
            </form>
            <div className="share-list">
              {shares.map((share) => (
                <div className="share-row" key={share.discordId}>
                  <Avatar src={share.avatarUrl} name={share.username || share.label} />
                  <span>
                    <strong>{share.username || share.label}</strong>
                    <small>{share.discordId} · {share.permission}</small>
                  </span>
                  <IconButton label="Remover acesso" onClick={() => removeShare(share.discordId)}>
                    <X size={17} />
                  </IconButton>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-title">
            <h3>Historico</h3>
            <History size={18} />
          </div>
          <Timeline history={history} />
        </section>

        {account.canShare && (
          <button className="danger-button wide" onClick={deleteAccount}>
            <Trash2 size={18} />
            Remover conta
          </button>
        )}
      </div>
    </section>
  );
}

function AccountForm({ mode, initial, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    ...emptyForm,
    ...initial,
    password: '',
    robloxUsername: initial?.roblox?.username || initial?.robloxUsername || ''
  }));
  const [roblox, setRoblox] = useState(initial?.roblox || null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);

  const isRoblox = form.platform.toLowerCase() === 'roblox';

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function lookupRoblox() {
    setStatus('');
    try {
      const payload = await api('/roblox/lookup', { method: 'POST', body: { username: form.robloxUsername || form.login } });
      setRoblox(payload.roblox);
      setForm((current) => ({
        ...current,
        robloxUsername: payload.roblox.username,
        login: current.login || payload.roblox.username,
        photoUrl: payload.roblox.avatarUrl || current.photoUrl
      }));
      setStatus('Conta Roblox encontrada.');
    } catch (error) {
      setRoblox(null);
      setStatus(error.message);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setStatus('');
    try {
      const payload = {
        ...form,
        platform: form.platform,
        photoUrl: roblox?.avatarUrl || form.photoUrl,
        robloxUsername: isRoblox ? form.robloxUsername : ''
      };
      if (mode === 'edit' && !payload.password) delete payload.password;
      const saved = mode === 'edit'
        ? await api(`/accounts/${initial.id}`, { method: 'PATCH', body: payload })
        : await api('/accounts', { method: 'POST', body: payload });
      await onSaved(saved.account);
      onClose();
    } catch (error) {
      setStatus(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function uploadAccountImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageUploading(true);
    setStatus('');
    try {
      const dataUrl = await fileToDataUrl(file);
      const payload = await api('/images', {
        method: 'POST',
        body: {
          name: file.name,
          dataUrl
        }
      });
      updateField('photoUrl', payload.image.url);
      setStatus('Imagem enviada e aplicada na conta.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setImageUploading(false);
      event.target.value = '';
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal account-form" onSubmit={submit}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">{mode === 'edit' ? 'Editar conta' : 'Adicionar conta'}</p>
            <h3>{mode === 'edit' ? initial.name : 'Nova conta'}</h3>
          </div>
          <IconButton label="Fechar" onClick={onClose} type="button"><X size={18} /></IconButton>
        </div>
        {status && <div className={status.includes('encontrada') ? 'notice success' : 'notice'}>{status}</div>}
        <div className="form-grid">
          <label>
            Nome da conta
            <input value={form.name} onChange={(event) => updateField('name', event.target.value)} required />
          </label>
          <label>
            Plataforma
            <select value={form.platform} onChange={(event) => updateField('platform', event.target.value)}>
              {platformOptions.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
            </select>
          </label>
          {isRoblox && (
            <label className="span-2">
              Roblox Username
              <div className="inline-field">
                <input
                  value={form.robloxUsername}
                  onChange={(event) => updateField('robloxUsername', event.target.value)}
                  placeholder="Username"
                />
                <button className="ghost-button" type="button" onClick={lookupRoblox}>
                  <Gamepad2 size={17} />
                  Buscar
                </button>
              </div>
            </label>
          )}
          {roblox && (
            <div className="roblox-found span-2">
              <Avatar src={roblox.avatarUrl} name={roblox.username} />
              <span>
                <strong>{roblox.username}</strong>
                <small>{roblox.displayName} · {roblox.userId}</small>
              </span>
              <Check size={18} />
            </div>
          )}
          <label>
            Usuario/Login
            <input value={form.login} onChange={(event) => updateField('login', event.target.value)} />
          </label>
          <label>
            Senha
            <input
              value={form.password}
              onChange={(event) => updateField('password', event.target.value)}
              type="password"
              required={mode !== 'edit'}
              placeholder={mode === 'edit' ? 'Manter senha atual' : ''}
            />
          </label>
          <label className="span-2">
            Foto
            <div className="inline-field">
              <input value={form.photoUrl || ''} onChange={(event) => updateField('photoUrl', event.target.value)} placeholder="https:// ou imagem enviada" />
              <label className="ghost-button file-picker">
                <Upload size={17} />
                {imageUploading ? 'Enviando' : 'Enviar'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadAccountImage} />
              </label>
            </div>
          </label>
          <label className="span-2">
            Observacoes
            <textarea value={form.notes || ''} onChange={(event) => updateField('notes', event.target.value)} rows={4} />
          </label>
        </div>
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>Cancelar</button>
          <button className="primary-button" disabled={saving}>
            <Save size={18} />
            {saving ? 'Salvando' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Timeline({ history }) {
  if (!history.length) return <EmptyState icon={History} title="Sem registros" />;
  return (
    <div className="timeline">
      {history.map((item) => (
        <div className="timeline-item" key={item.id}>
          <span className="timeline-dot" />
          <div>
            <strong>{historyLabels[item.action] || item.action}</strong>
            <small>
              {item.accountName ? `${item.accountName} · ` : ''}
              {item.actorUsername || item.actorDiscordId || 'Sistema'} · {formatDate(item.createdAt)}
            </small>
            {item.metadata?.fields?.length > 0 && <p>{item.metadata.fields.join(', ')}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryPage({ history }) {
  return (
    <section className="page">
      <PageHeader eyebrow="Auditoria" title="Historico de alteracoes" />
      <section className="panel">
        <Timeline history={history} />
      </section>
    </section>
  );
}

function UsersPage({ users, reloadUsers }) {
  const [form, setForm] = useState({ discordId: '', role: 'member', label: '' });
  const [message, setMessage] = useState('');

  async function submit(event) {
    event.preventDefault();
    await api('/authorized-users', { method: 'POST', body: form });
    setForm({ discordId: '', role: 'member', label: '' });
    setMessage('Usuario autorizado salvo.');
    await reloadUsers();
  }

  async function remove(discordId) {
    await api(`/authorized-users/${discordId}`, { method: 'DELETE' });
    setMessage('Acesso removido.');
    await reloadUsers();
  }

  return (
    <section className="page">
      <PageHeader eyebrow="Whitelist" title="Usuarios autorizados" />
      {message && <div className="notice success">{message}</div>}
      <section className="panel">
        <form className="user-form" onSubmit={submit}>
          <input
            value={form.discordId}
            onChange={(event) => setForm((current) => ({ ...current, discordId: event.target.value }))}
            placeholder="Discord ID"
            required
          />
          <input
            value={form.label}
            onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
            placeholder="Apelido"
          />
          <select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
          <button className="primary-button"><Plus size={17} /> Autorizar</button>
        </form>
      </section>
      <div className="user-grid">
        {users.map((user) => (
          <article className="user-card" key={user.discordId}>
            <Avatar src={user.avatarUrl} name={user.globalName || user.username || user.label} />
            <span>
              <strong>{user.globalName || user.username || user.label}</strong>
              <small>{user.discordId}</small>
            </span>
            <span className="tag"><Shield size={15} /> {user.role}</span>
            <small>Ultimo login: {formatDate(user.lastLoginAt)}</small>
            <IconButton label="Remover" onClick={() => remove(user.discordId)}>
              <Trash2 size={17} />
            </IconButton>
          </article>
        ))}
      </div>
    </section>
  );
}

function MediaPage() {
  const [folders, setFolders] = useState([]);
  const [images, setImages] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [folderName, setFolderName] = useState('');
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);

  const loadFolders = useCallback(async () => {
    const payload = await api('/image-folders');
    setFolders(payload.folders);
  }, []);

  const loadImages = useCallback(async () => {
    const query = selectedFolderId ? `?folderId=${encodeURIComponent(selectedFolderId)}` : '';
    const payload = await api(`/images${query}`);
    setImages(payload.images);
  }, [selectedFolderId]);

  useEffect(() => {
    loadFolders().catch((error) => setMessage(error.message));
  }, [loadFolders]);

  useEffect(() => {
    loadImages().catch((error) => setMessage(error.message));
  }, [loadImages]);

  async function createFolder(event) {
    event.preventDefault();
    if (!folderName.trim()) return;
    const payload = await api('/image-folders', { method: 'POST', body: { name: folderName } });
    setFolderName('');
    setSelectedFolderId(payload.folder.id);
    setMessage('Pasta criada.');
    await loadFolders();
  }

  async function uploadFiles(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    setUploading(true);
    setMessage('');
    try {
      for (const file of files) {
        const dataUrl = await fileToDataUrl(file);
        await api('/images', {
          method: 'POST',
          body: {
            folderId: selectedFolderId || null,
            name: file.name,
            dataUrl
          }
        });
      }
      setMessage('Imagem enviada.');
      await Promise.all([loadFolders(), loadImages()]);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  async function deleteImage(imageId) {
    await api(`/images/${imageId}`, { method: 'DELETE' });
    setMessage('Imagem removida.');
    await Promise.all([loadFolders(), loadImages()]);
  }

  async function deleteFolder(folderId) {
    await api(`/image-folders/${folderId}`, { method: 'DELETE' });
    if (selectedFolderId === folderId) setSelectedFolderId('');
    setMessage('Pasta removida.');
    await Promise.all([loadFolders(), loadImages()]);
  }

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);

  return (
    <section className="page">
      <PageHeader eyebrow="Biblioteca local" title="Imagens" />
      {message && <div className="notice">{message}</div>}
      <div className="media-layout">
        <section className="panel">
          <div className="panel-title">
            <h3>Pastas</h3>
            <FolderPlus size={18} />
          </div>
          <form className="folder-form" onSubmit={createFolder}>
            <input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="Nova pasta" />
            <button className="primary-button"><Plus size={17} /> Criar</button>
          </form>
          <div className="folder-list">
            <button className={!selectedFolderId ? 'active' : ''} onClick={() => setSelectedFolderId('')}>
              <ImageIcon size={17} />
              Sem pasta
            </button>
            {folders.map((folder) => (
              <div className="folder-row" key={folder.id}>
                <button className={selectedFolderId === folder.id ? 'active' : ''} onClick={() => setSelectedFolderId(folder.id)}>
                  <ImageIcon size={17} />
                  <span>{folder.name}</span>
                  <small>{folder.imageCount}</small>
                </button>
                <IconButton label="Remover pasta" onClick={() => deleteFolder(folder.id)}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>{selectedFolder?.name || 'Sem pasta'}</h3>
              <small>{images.length} imagem(ns)</small>
            </div>
            <label className="upload-button">
              <Upload size={17} />
              {uploading ? 'Enviando' : 'Enviar'}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={uploadFiles} />
            </label>
          </div>
          <div className="image-grid">
            {images.map((image) => (
              <article className="image-card" key={image.id}>
                <img src={image.url} alt="" />
                <span>
                  <strong>{image.name}</strong>
                  <small>{Math.ceil(image.sizeBytes / 1024)} KB</small>
                </span>
                <div className="card-actions">
                  <IconButton label="Copiar URL" onClick={() => copyText(image.url)}>
                    <Copy size={16} />
                  </IconButton>
                  <IconButton label="Remover imagem" onClick={() => deleteImage(image.id)}>
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </article>
            ))}
          </div>
          {images.length === 0 && <EmptyState icon={ImageIcon} title="Nenhuma imagem nesta pasta" />}
        </section>
      </div>
    </section>
  );
}

function ProfilePage({ user }) {
  return (
    <section className="page">
      <PageHeader eyebrow="Conta conectada" title="Perfil" />
      <section className="panel profile-panel">
        <Avatar src={user.avatarUrl} name={user.globalName || user.username} size="xl" />
        <div>
          <h3>{user.globalName || user.username}</h3>
          <p className="muted">@{user.username}</p>
          <div className="tag-line">
            <span className="tag"><ShieldCheck size={15} /> {user.role}</span>
            <span className="tag">Discord ID {user.discordId}</span>
          </div>
        </div>
      </section>
    </section>
  );
}

function SettingsPage({ theme, setTheme, onBackup }) {
  return (
    <section className="page">
      <PageHeader eyebrow="Preferencias" title="Configuracoes" />
      <div className="settings-grid">
        <section className="panel">
          <div className="panel-title">
            <h3>Tema</h3>
            <Sparkles size={18} />
          </div>
          <div className="segmented">
            <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}><Sun size={17} /> Claro</button>
            <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}><Moon size={17} /> Escuro</button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <h3>Backup</h3>
            <DatabaseBackup size={18} />
          </div>
          <button className="primary-button" onClick={onBackup}><DatabaseBackup size={18} /> Exportar</button>
        </section>
      </div>
    </section>
  );
}

function copyText(text) {
  if (!text) return;
  navigator.clipboard?.writeText(text);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Nao foi possivel ler a imagem.'));
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [theme, setThemeState] = useState(() => localStorage.getItem('nexus-theme') || 'dark');
  const [session, setSession] = useState({ loading: true, user: null });
  const [view, setView] = useState('dashboard');
  const [accounts, setAccounts] = useState([]);
  const [history, setHistory] = useState([]);
  const [authorizedUsers, setAuthorizedUsers] = useState([]);
  const [filters, setFilters] = useState({ search: '', platform: '' });
  const [formMode, setFormMode] = useState(null);
  const [editingAccount, setEditingAccount] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [toast, setToast] = useState('');

  const setTheme = useCallback((value) => {
    setThemeState(value);
    localStorage.setItem('nexus-theme', value);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const loadMe = useCallback(async () => {
    try {
      const payload = await api('/auth/me');
      setSession({ loading: false, user: payload.user });
    } catch {
      setSession({ loading: false, user: null });
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    const query = new URLSearchParams();
    if (filters.search) query.set('search', filters.search);
    if (filters.platform) query.set('platform', filters.platform);
    const payload = await api(`/accounts?${query}`);
    setAccounts(payload.accounts);
  }, [filters]);

  const loadHistory = useCallback(async () => {
    const payload = await api('/history');
    setHistory(payload.history);
  }, []);

  const loadAuthorizedUsers = useCallback(async () => {
    if (!['owner', 'admin'].includes(session.user?.role)) return;
    const payload = await api('/authorized-users');
    setAuthorizedUsers(payload.users);
  }, [session.user?.role]);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  useEffect(() => {
    if (!session.user) return;
    loadAccounts().catch((error) => setToast(error.message));
  }, [session.user, loadAccounts]);

  useEffect(() => {
    if (!session.user) return;
    loadHistory().catch(() => {});
    loadAuthorizedUsers().catch(() => {});
  }, [session.user, loadHistory, loadAuthorizedUsers]);

  async function refreshAll() {
    await Promise.all([loadAccounts(), loadHistory(), loadAuthorizedUsers()]);
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setSession({ loading: false, user: null });
  }

  function openCreate() {
    setEditingAccount(null);
    setFormMode('create');
  }

  function openEdit(account) {
    setEditingAccount(account);
    setFormMode('edit');
  }

  function openDetails(account) {
    setSelectedAccount(account);
    setView('details');
  }

  async function exportBackup() {
    try {
      const payload = await api('/backup');
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `nexus-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setToast('Backup criptografado exportado.');
    } catch (error) {
      setToast(error.message);
    }
  }

  const filteredAccounts = accounts;

  if (session.loading) {
    return (
      <div className="loading-screen">
        <ShieldCheck size={38} />
        <span>Carregando Nexus</span>
      </div>
    );
  }

  if (!session.user) return <LoginScreen />;

  return (
    <Shell
      user={session.user}
      theme={theme}
      onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      onLogout={logout}
      view={view}
      setView={setView}
    >
      {toast && (
        <button className="toast" onClick={() => setToast('')}>
          {toast}
          <X size={16} />
        </button>
      )}
      {view === 'dashboard' && (
        <Dashboard
          accounts={filteredAccounts}
          history={history}
          setView={setView}
          setSelectedAccount={setSelectedAccount}
        />
      )}
      {view === 'accounts' && (
        <AccountsPage
          accounts={filteredAccounts}
          filters={filters}
          setFilters={setFilters}
          onCreate={openCreate}
          onEdit={openEdit}
          onOpen={openDetails}
        />
      )}
      {view === 'details' && selectedAccount && (
        <AccountDetails
          account={selectedAccount}
          onBack={() => setView('accounts')}
          onEdit={openEdit}
          onRefresh={refreshAll}
          onDeleted={async () => {
            setSelectedAccount(null);
            setView('accounts');
            await refreshAll();
          }}
        />
      )}
      {view === 'history' && <HistoryPage history={history} />}
      {view === 'images' && <MediaPage />}
      {view === 'users' && <UsersPage users={authorizedUsers} reloadUsers={loadAuthorizedUsers} />}
      {view === 'settings' && <SettingsPage theme={theme} setTheme={setTheme} onBackup={exportBackup} />}
      {view === 'profile' && <ProfilePage user={session.user} />}
      {formMode && (
        <AccountForm
          mode={formMode}
          initial={editingAccount || {}}
          onClose={() => setFormMode(null)}
          onSaved={async (account) => {
            setSelectedAccount(account);
            await refreshAll();
          }}
        />
      )}
    </Shell>
  );
}
