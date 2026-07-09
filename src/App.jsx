import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  Ban,
  Bell,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  Clipboard,
  Clock3,
  Code2,
  Copy,
  Crown,
  DatabaseBackup,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Film,
  FolderPlus,
  Gamepad2,
  Gavel,
  Hash,
  History,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogIn,
  LogOut,
  Mail,
  MailOpen,
  MessageSquare,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Server,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  ScrollText,
  Shuffle,
  Sun,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Upload,
  UserCog,
  Users,
  Volume2,
  Maximize2,
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
const authenticatorPeriodOptions = [10, 15, 20, 30, 45, 60, 90, 120];
const ROBLOX_GENERATOR_PAGE_SIZE = 24;

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
      {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <span>{initials(name)}</span>}
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

function Shell({ user, theme, resolvedTheme, onToggleTheme, onLogout, view, setView, children }) {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'accounts', label: 'Cofre', icon: KeyRound },
    { id: 'roblox-generator', label: 'Gerador', icon: Gamepad2 },
    { id: 'authenticator', label: 'Codigos', icon: Lock },
    { id: 'temp-email', label: 'Temp Email', icon: Mail },
    { id: 'images', label: 'Midia', icon: Film },
    { id: 'discord-tools', label: 'Discord', icon: Bot },
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
            <IconButton label={resolvedTheme === 'dark' ? 'Tema claro' : 'Tema escuro'} onClick={onToggleTheme}>
              {resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </IconButton>
            <IconButton label="Sair" onClick={onLogout}>
              <LogOut size={18} />
            </IconButton>
          </div>
        </div>
      </aside>
      <header className="mobile-topbar">
        <button className="mobile-brand" onClick={() => setView('dashboard')}>
          <span className="brand-mark compact"><ShieldCheck size={21} /></span>
          <strong>Nexus</strong>
        </button>
        <div className="mobile-actions">
          <IconButton label={theme === 'system' ? 'Tema do aparelho' : resolvedTheme === 'dark' ? 'Tema claro' : 'Tema escuro'} onClick={onToggleTheme}>
            {theme === 'system' ? <Palette size={18} /> : resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </IconButton>
          <IconButton label="Perfil" onClick={() => setView('profile')}>
            <UserCog size={18} />
          </IconButton>
        </div>
      </header>
      <main className="content">{children}</main>
      <nav className="mobile-nav">
        {navItems.map((item) => {
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
      <strong><AnimatedNumber value={value} /></strong>
    </article>
  );
}

function AnimatedNumber({ value }) {
  const [displayValue, setDisplayValue] = useState(0);
  const previousValue = useRef(0);

  useEffect(() => {
    const targetValue = Number(value || 0);
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setDisplayValue(targetValue);
      previousValue.current = targetValue;
      return undefined;
    }

    const startValue = previousValue.current;
    const startTime = performance.now();
    const duration = 720;
    let frameId = 0;

    function tick(now) {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = Math.round(startValue + (targetValue - startValue) * eased);
      setDisplayValue(nextValue);
      if (progress < 1) {
        frameId = requestAnimationFrame(tick);
      } else {
        previousValue.current = targetValue;
      }
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [value]);

  return displayValue;
}

function useDebouncedValue(value, delay = 220) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

function mergeGeneratorAccounts(current, next) {
  const byId = new Map(current.map((account) => [account.id, account]));
  for (const account of next) byId.set(account.id, account);
  return Array.from(byId.values());
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

function RobloxGeneratorPage({ user }) {
  const [accounts, setAccounts] = useState([]);
  const [filters, setFilters] = useState({ search: '', status: '' });
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagination, setPagination] = useState({ nextOffset: 0, hasMore: true, total: null });
  const [importing, setImporting] = useState(false);
  const debouncedFilters = useDebouncedValue(filters, 240);
  const requestIdRef = useRef(0);
  const loadMoreRef = useRef(null);
  const loadingMoreRef = useRef(false);
  const canImport = ['owner', 'admin'].includes(user.role);

  const loadAccounts = useCallback(async ({
    offset = 0,
    mode = 'replace',
    silent = false,
    limit = ROBLOX_GENERATOR_PAGE_SIZE
  } = {}) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const shouldAppend = mode === 'append';

    if (shouldAppend) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else if (!silent) {
      setListLoading(true);
    }

    const query = new URLSearchParams();
    if (debouncedFilters.search) query.set('search', debouncedFilters.search);
    if (debouncedFilters.status) query.set('status', debouncedFilters.status);
    query.set('limit', String(limit));
    query.set('offset', String(offset));

    try {
      const payload = await api(`/roblox-generator/accounts?${query}`);
      if (requestId === requestIdRef.current) {
        const nextAccounts = payload.accounts || [];
        const page = payload.page || {};
        setAccounts((current) => (
          shouldAppend ? mergeGeneratorAccounts(current, nextAccounts) : nextAccounts
        ));
        setPagination({
          nextOffset: Number.isFinite(Number(page.nextOffset)) ? Number(page.nextOffset) : offset + nextAccounts.length,
          hasMore: Boolean(page.hasMore),
          total: page.total ?? null
        });
      }
    } finally {
      if (requestId === requestIdRef.current) {
        if (shouldAppend) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        } else {
          setListLoading(false);
        }
      } else if (shouldAppend) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [debouncedFilters]);

  useEffect(() => {
    setAccounts([]);
    setPagination({ nextOffset: 0, hasMore: true, total: null });
    loadAccounts({ offset: 0, mode: 'replace' }).catch((error) => setMessage(error.message));
  }, [loadAccounts]);

  const refreshVisibleAccounts = useCallback(async () => {
    const visibleLimit = Math.min(80, Math.max(ROBLOX_GENERATOR_PAGE_SIZE, accounts.length || ROBLOX_GENERATOR_PAGE_SIZE));
    await loadAccounts({ offset: 0, mode: 'replace', silent: true, limit: visibleLimit });
  }, [accounts.length, loadAccounts]);

  const loadMoreAccounts = useCallback(() => {
    if (!pagination.hasMore || listLoading || loadingMoreRef.current) return;
    loadAccounts({
      offset: pagination.nextOffset,
      mode: 'append',
      silent: true
    }).catch((error) => setMessage(error.message));
  }, [listLoading, loadAccounts, pagination.hasMore, pagination.nextOffset]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !pagination.hasMore) return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreAccounts();
    }, {
      root: null,
      rootMargin: '520px 0px',
      threshold: 0.01
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [accounts.length, loadMoreAccounts, pagination.hasMore]);

  async function importTxt(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setMessage('');
    try {
      const text = await fileToText(file);
      const payload = await api('/roblox-generator/import', {
        method: 'POST',
        body: {
          text,
          sourceLabel: file.name
        }
      });
      const result = payload.result;
      setMessage(`${result.imported} conta(s) importada(s). ${result.created} nova(s), ${result.updated} atualizada(s).`);
      setAccounts([]);
      await loadAccounts({ offset: 0, mode: 'replace', silent: true });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setImporting(false);
      event.target.value = '';
    }
  }

  async function selectAccount(account) {
    setLoading(true);
    setMessage('');
    try {
      const payload = await api(`/roblox-generator/accounts/${account.id}/select`, { method: 'POST' });
      setSelectedAccount(payload.account);
      setMessage('Conta selecionada.');
      await refreshVisibleAccounts();
      return payload.account;
    } catch (error) {
      setMessage(error.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function openDetails(account) {
    setLoading(true);
    setMessage('');
    try {
      const payload = await api(`/roblox-generator/accounts/${account.id}`);
      setSelectedAccount(payload.account);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function randomAccount() {
    setLoading(true);
    setMessage('');
    try {
      const payload = await api('/roblox-generator/random', { method: 'POST' });
      setSelectedAccount(payload.account);
      setMessage('Conta aleatoria selecionada.');
      await refreshVisibleAccounts();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function copyAccountData(account) {
    if (account.status !== 'available') {
      setMessage('Essa conta esta online no Roblox agora.');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const payload = await api(`/roblox-generator/accounts/${account.id}/select`, { method: 'POST' });
      setSelectedAccount(payload.account);
      await copyText(formatRobloxGeneratorData(payload.account));
      setMessage('Dados copiados.');
      await refreshVisibleAccounts();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function deleteGeneratorAccount(account) {
    const confirmed = window.confirm(`Excluir ${account.username} do gerador?`);
    if (!confirmed) return;
    setLoading(true);
    setMessage('');
    try {
      await api(`/roblox-generator/accounts/${account.id}`, { method: 'DELETE' });
      if (selectedAccount?.id === account.id) setSelectedAccount(null);
      setMessage('Conta removida do gerador.');
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      await refreshVisibleAccounts();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  const availableCount = accounts.filter((account) => account.status === 'available').length;
  const inUseCount = accounts.filter((account) => account.status === 'in_use').length;
  const showSkeleton = listLoading && accounts.length === 0;
  const totalCount = typeof pagination.total === 'number' ? pagination.total : null;

  return (
    <section className="page">
      <PageHeader
        eyebrow="Roblox"
        title="Gerador de Contas"
        actions={
          <>
            {canImport && (
              <label className="upload-button">
                <Upload size={17} />
                {importing ? 'Importando' : 'Importar TXT'}
                <input type="file" accept=".txt,text/plain" onChange={importTxt} />
              </label>
            )}
            <button className="primary-button" onClick={randomAccount} disabled={loading}>
              <Shuffle size={18} />
              Gerar Conta Aleatoria
            </button>
          </>
        }
      />
      {message && <div className="notice">{message}</div>}
      <div className="toolbar">
        <label className="search-box">
          <Search size={18} />
          <input
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
            placeholder="Pesquisar username ou display name"
          />
        </label>
        <label className="select-box">
          <SlidersHorizontal size={18} />
          <select
            value={filters.status}
            onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
          >
            <option value="">Todas</option>
            <option value="available">Offline / disponiveis</option>
            <option value="in_use">Online / em uso</option>
          </select>
        </label>
      </div>
      <div className="status-strip">
        <span><BadgeCheck size={15} /> {availableCount} offline</span>
        <span><Clock3 size={15} /> {inUseCount} online</span>
        <span><Gamepad2 size={15} /> {accounts.length}{totalCount ? `/${totalCount}` : ''} carregadas</span>
      </div>
      <div className="roblox-generator-layout">
        <section className="panel roblox-selected-panel">
          <div className="panel-title">
            <h3>Conta selecionada</h3>
            <Gamepad2 size={18} />
          </div>
          {selectedAccount ? (
            <div className="roblox-selected-card" key={selectedAccount.id}>
              <Avatar src={selectedAccount.avatarUrl} name={selectedAccount.username} size="xl" />
              <div>
                <h3>{selectedAccount.username}</h3>
                <p className="muted">{selectedAccount.displayName || 'Sem Display Name'}</p>
                <div className="tag-line">
                  <span className={getRobloxStatusClass(selectedAccount)}>
                    {getRobloxStatusLabel(selectedAccount)}
                  </span>
                  {selectedAccount.userId && <span className="tag">UserId {selectedAccount.userId}</span>}
                </div>
              </div>
              <div className="secret-box">
                <span>Login</span>
                <strong>{selectedAccount.username}</strong>
              </div>
              <div className="secret-box">
                <span>Senha</span>
                <strong>{selectedAccount.password || 'Selecione ou copie quando estiver offline'}</strong>
              </div>
              <div className="card-actions">
                <button className="primary-button" onClick={() => copyAccountData(selectedAccount)} disabled={loading || selectedAccount.status !== 'available'}>
                  <Copy size={17} />
                  Copiar Dados
                </button>
                {canImport && (
                  <button className="danger-button" onClick={() => deleteGeneratorAccount(selectedAccount)} disabled={loading}>
                    <Trash2 size={17} />
                    Excluir
                  </button>
                )}
                {selectedAccount.profileUrl && (
                  <a className="ghost-button" href={selectedAccount.profileUrl} target="_blank" rel="noreferrer">
                    <Gamepad2 size={17} />
                    Perfil
                  </a>
                )}
              </div>
            </div>
          ) : (
            <EmptyState icon={Gamepad2} title="Nenhuma conta selecionada" />
          )}
        </section>
        <section className={`roblox-generator-grid ${listLoading ? 'is-loading' : ''}`} aria-busy={listLoading}>
          {showSkeleton && Array.from({ length: 6 }, (_, index) => (
            <article className="roblox-generator-card roblox-generator-skeleton" key={`skeleton-${index}`}>
              <span className="skeleton-avatar" />
              <span className="skeleton-line wide" />
              <span className="skeleton-line short" />
              <span className="skeleton-pill" />
              <div className="card-actions">
                <span className="skeleton-button" />
                <span className="skeleton-button" />
              </div>
            </article>
          ))}
          {!showSkeleton && accounts.map((account) => (
            <article className="roblox-generator-card" key={account.id}>
              <button className="account-main" onClick={() => openDetails(account)}>
                <Avatar src={account.avatarUrl} name={account.username} size="lg" />
                <span>
                  <strong>{account.username}</strong>
                  <small>{account.displayName || 'Sem Display Name'}</small>
                </span>
              </button>
              <div className="tag-line">
                <span className={getRobloxStatusClass(account)}>
                  {getRobloxStatusLabel(account)}
                </span>
                {account.userId && <span className="tag">UserId {account.userId}</span>}
              </div>
              <div className="card-actions">
                <button className="ghost-button" onClick={() => selectAccount(account)} disabled={loading || account.status !== 'available'}>
                  <BadgeCheck size={17} />
                  Selecionar
                </button>
                <button className="primary-button" onClick={() => copyAccountData(account)} disabled={loading || account.status !== 'available'}>
                  <Copy size={17} />
                  Copiar Dados
                </button>
                {canImport && (
                  <IconButton label="Excluir do gerador" onClick={() => deleteGeneratorAccount(account)} disabled={loading}>
                    <Trash2 size={16} />
                  </IconButton>
                )}
              </div>
            </article>
          ))}
          {!listLoading && accounts.length === 0 && <EmptyState icon={Gamepad2} title="Nenhuma conta Roblox carregada" />}
          {!showSkeleton && pagination.hasMore && (
            <div className="roblox-generator-sentinel" ref={loadMoreRef}>
              {loadingMore ? (
                <>
                  <RefreshCw size={17} />
                  Carregando mais contas
                </>
              ) : (
                <>
                  <ChevronRight size={17} />
                  Role para carregar mais
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function AuthenticatorPage() {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ label: '', issuer: '', username: '', secret: '', notes: '', period: 30 });
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const loadAuthenticators = useCallback(async () => {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const payload = await api(`/authenticators${query}`);
    setItems(payload.authenticators);
  }, [search]);

  useEffect(() => {
    loadAuthenticators().catch((error) => setMessage(error.message));
  }, [loadAuthenticators]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      loadAuthenticators().catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loadAuthenticators]);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function createCode(event) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      await api('/authenticators', { method: 'POST', body: { ...form, period: Number(form.period) || 30 } });
      setForm({ label: '', issuer: '', username: '', secret: '', notes: '', period: 30 });
      setMessage('Autenticador salvo.');
      await loadAuthenticators();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteCode(item) {
    const confirmed = window.confirm(`Excluir autenticador ${item.label}?`);
    if (!confirmed) return;
    await api(`/authenticators/${item.id}`, { method: 'DELETE' });
    setMessage('Autenticador removido.');
    await loadAuthenticators();
  }

  async function updateCodePeriod(item, period) {
    const nextPeriod = Number(period) || 30;
    await api(`/authenticators/${item.id}`, { method: 'PATCH', body: { period: nextPeriod } });
    setMessage(`Tempo de ${item.label} alterado para ${nextPeriod}s.`);
    await loadAuthenticators();
  }

  return (
    <section className="page">
      <PageHeader eyebrow="2FA" title="Autenticador de Codigos" />
      {message && <div className="notice">{message}</div>}
      <div className="authenticator-layout">
        <section className="panel">
          <div className="panel-title">
            <h3>Novo codigo</h3>
            <Lock size={18} />
          </div>
          <form className="authenticator-form" onSubmit={createCode}>
            <label>
              Nome
              <input value={form.label} onChange={(event) => updateForm('label', event.target.value)} placeholder="Roblox principal" />
            </label>
            <label>
              Emissor
              <input value={form.issuer} onChange={(event) => updateForm('issuer', event.target.value)} placeholder="Roblox, Discord..." />
            </label>
            <label>
              Usuario
              <input value={form.username} onChange={(event) => updateForm('username', event.target.value)} placeholder="login ou email" />
            </label>
            <label>
              Segredo ou otpauth://
              <textarea
                value={form.secret}
                onChange={(event) => updateForm('secret', event.target.value)}
                rows={4}
                placeholder="Cole o segredo Base32 ou a URI otpauth://"
                required
              />
            </label>
            <label>
              Observacoes
              <textarea value={form.notes} onChange={(event) => updateForm('notes', event.target.value)} rows={3} />
            </label>
            <label>
              Tempo para trocar codigo
              <select value={form.period} onChange={(event) => updateForm('period', Number(event.target.value))}>
                {authenticatorPeriodOptions.map((period) => (
                  <option key={period} value={period}>{period} segundos</option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={saving}>
              <Save size={18} />
              {saving ? 'Salvando' : 'Salvar codigo'}
            </button>
          </form>
        </section>
        <section className="panel">
          <div className="panel-title">
            <h3>Codigos salvos</h3>
            <Clock3 size={18} />
          </div>
          <label className="search-box authenticator-search">
            <Search size={18} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar codigo" />
          </label>
          <div className="authenticator-grid">
            {items.map((item) => (
              <article className="authenticator-card" key={item.id}>
                <div className="authenticator-card-head">
                  <span>
                    <strong>{item.label}</strong>
                    <small>{[item.issuer, item.username].filter(Boolean).join(' - ') || 'Sem emissor'}</small>
                  </span>
                  <span className="tag"><Clock3 size={15} /> {item.secondsRemaining}s / {item.period}s</span>
                </div>
                <button className="authenticator-code" onClick={() => copyText(item.code)}>
                  {item.code || '------'}
                </button>
                <div className="authenticator-progress">
                  <span style={{ width: `${Math.max(4, (item.secondsRemaining / item.period) * 100)}%` }} />
                </div>
                <label className="authenticator-period-control">
                  Trocar a cada
                  <select value={item.period} onChange={(event) => updateCodePeriod(item, event.target.value)}>
                    {authenticatorPeriodOptions.map((period) => (
                      <option key={period} value={period}>{period}s</option>
                    ))}
                  </select>
                </label>
                <div className="card-actions">
                  <button className="primary-button" onClick={() => copyText(item.code)}>
                    <Copy size={17} />
                    Copiar
                  </button>
                  <IconButton label="Excluir autenticador" onClick={() => deleteCode(item)}>
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </article>
            ))}
            {items.length === 0 && <EmptyState icon={Lock} title="Nenhum codigo salvo" />}
          </div>
        </section>
      </div>
    </section>
  );
}

function formatSender(sender = {}) {
  if (!sender.name) return sender.address || 'Remetente desconhecido';
  if (!sender.address) return sender.name;
  return `${sender.name} <${sender.address}>`;
}

function TempEmailPage() {
  const [inboxes, setInboxes] = useState([]);
  const [domains, setDomains] = useState([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ label: '', prefix: '', domain: '' });
  const [selectedInbox, setSelectedInbox] = useState(null);
  const [messages, setMessages] = useState([]);
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadInboxes = useCallback(async () => {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const payload = await api(`/temp-email/inboxes${query}`);
    setInboxes(payload.inboxes);
    setSelectedInbox((current) => {
      if (!current) return payload.inboxes[0] || null;
      return payload.inboxes.find((inbox) => inbox.id === current.id) || payload.inboxes[0] || null;
    });
  }, [search]);

  useEffect(() => {
    api('/temp-email/domains')
      .then((payload) => {
        setDomains(payload.domains);
        setForm((current) => ({ ...current, domain: current.domain || payload.domains[0]?.domain || '' }));
      })
      .catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    loadInboxes().catch((error) => setNotice(error.message));
  }, [loadInboxes]);

  const loadMessages = useCallback(async (inbox = selectedInbox) => {
    if (!inbox) {
      setMessages([]);
      setSelectedMessage(null);
      return;
    }
    setLoading(true);
    setNotice('');
    try {
      const payload = await api(`/temp-email/inboxes/${inbox.id}/messages`);
      setMessages(payload.messages);
      setSelectedMessage((current) => {
        if (!current) return null;
        return payload.messages.find((message) => message.id === current.id) ? current : null;
      });
    } catch (error) {
      setNotice(error.message);
    } finally {
      setLoading(false);
    }
  }, [selectedInbox]);

  useEffect(() => {
    loadMessages().catch(() => {});
  }, [selectedInbox, loadMessages]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      loadMessages().catch(() => {});
    }, 12000);
    return () => window.clearInterval(timer);
  }, [loadMessages]);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function createInbox(event) {
    event.preventDefault();
    setCreating(true);
    setNotice('');
    try {
      const payload = await api('/temp-email/inboxes', { method: 'POST', body: form });
      setForm((current) => ({ label: '', prefix: '', domain: current.domain }));
      setSelectedInbox(payload.inbox);
      setNotice('Email temporario criado.');
      await loadInboxes();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setCreating(false);
    }
  }

  async function deleteInbox(inbox) {
    const confirmed = window.confirm(`Excluir ${inbox.address}?`);
    if (!confirmed) return;
    await api(`/temp-email/inboxes/${inbox.id}`, { method: 'DELETE' });
    setSelectedInbox(null);
    setSelectedMessage(null);
    setMessages([]);
    setNotice('Email temporario removido.');
    await loadInboxes();
  }

  async function openMessage(message) {
    if (!selectedInbox) return;
    setLoading(true);
    setNotice('');
    try {
      const payload = await api(`/temp-email/inboxes/${selectedInbox.id}/messages/${message.id}`);
      setSelectedMessage(payload.message);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setLoading(false);
    }
  }

  const mailText = selectedMessage?.text || selectedMessage?.intro || '';

  return (
    <section className="page">
      <PageHeader eyebrow="Firemail" title="Temp Email" />
      {notice && <div className="notice">{notice}</div>}
      <div className="temp-email-layout">
        <section className="panel">
          <div className="panel-title">
            <h3>Criar email</h3>
            <Mail size={18} />
          </div>
          <form className="temp-email-form" onSubmit={createInbox}>
            <label>
              Nome
              <input value={form.label} onChange={(event) => updateForm('label', event.target.value)} placeholder="Roblox teste" />
            </label>
            <label>
              Prefixo
              <input value={form.prefix} onChange={(event) => updateForm('prefix', event.target.value)} placeholder="nexusconta" />
            </label>
            <label>
              Dominio
              <select value={form.domain} onChange={(event) => updateForm('domain', event.target.value)}>
                {domains.map((domain) => (
                  <option key={domain.id || domain.domain} value={domain.domain}>{domain.domain}</option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={creating || domains.length === 0}>
              <Plus size={17} />
              {creating ? 'Criando' : 'Criar email'}
            </button>
          </form>
          <div className="temp-email-source">
            <MailOpen size={17} />
            <a href="https://firemail.com.br/api" target="_blank" rel="noreferrer">Powered by Firemail</a>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>Caixas</h3>
            <IconButton label="Atualizar caixas" onClick={loadInboxes}>
              <RefreshCw size={16} />
            </IconButton>
          </div>
          <label className="search-box temp-email-search">
            <Search size={18} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar email" />
          </label>
          <div className="temp-email-inbox-list">
            {inboxes.map((inbox) => (
              <article className={selectedInbox?.id === inbox.id ? 'temp-email-inbox active' : 'temp-email-inbox'} key={inbox.id}>
                <button onClick={() => setSelectedInbox(inbox)}>
                  <span>
                    <strong>{inbox.label || inbox.address}</strong>
                    <small>{inbox.address}</small>
                  </span>
                  <Mail size={18} />
                </button>
                <div className="card-actions">
                  <IconButton label="Copiar email" onClick={() => copyText(inbox.address)}>
                    <Copy size={16} />
                  </IconButton>
                  <IconButton label="Excluir email" onClick={() => deleteInbox(inbox)}>
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </article>
            ))}
            {inboxes.length === 0 && <EmptyState icon={Mail} title="Nenhum email temporario" />}
          </div>
        </section>

        <section className="panel temp-email-messages-panel">
          <div className="panel-title">
            <div>
              <h3>{selectedInbox?.address || 'Mensagens'}</h3>
              <small>{selectedInbox?.lastCheckedAt ? `Atualizado ${formatDate(selectedInbox.lastCheckedAt)}` : 'Aguardando caixa'}</small>
            </div>
            <button className="ghost-button" onClick={() => loadMessages()} disabled={!selectedInbox || loading}>
              <RefreshCw size={17} />
              {loading ? 'Atualizando' : 'Atualizar'}
            </button>
          </div>
          <div className="temp-email-messages">
            {messages.map((message) => (
              <button className={selectedMessage?.id === message.id ? 'temp-email-message active' : 'temp-email-message'} key={message.id} onClick={() => openMessage(message)}>
                <span>
                  <strong>{message.subject}</strong>
                  <small>{formatSender(message.from)}</small>
                </span>
                <small>{message.createdAt ? formatDate(message.createdAt) : ''}</small>
                {message.intro && <p>{message.intro}</p>}
              </button>
            ))}
            {selectedInbox && messages.length === 0 && <EmptyState icon={MailOpen} title="Nenhuma mensagem ainda" />}
            {!selectedInbox && <EmptyState icon={Mail} title="Crie ou selecione um email" />}
          </div>
        </section>

        <section className="panel temp-email-reader">
          <div className="panel-title">
            <div>
              <h3>{selectedMessage?.subject || 'Leitor'}</h3>
              <small>{selectedMessage ? formatSender(selectedMessage.from) : 'Abra uma mensagem'}</small>
            </div>
            {selectedMessage && (
              <button className="primary-button" onClick={() => copyText(mailText)}>
                <Copy size={17} />
                Copiar
              </button>
            )}
          </div>
          {selectedMessage ? (
            <div className="temp-email-reader-body">
              <pre>{mailText || 'Mensagem sem texto.'}</pre>
              {selectedMessage.links?.length > 0 && (
                <div className="temp-email-links">
                  {selectedMessage.links.map((link) => (
                    <button className="ghost-button" key={link} onClick={() => copyText(link)}>
                      <Copy size={16} />
                      Copiar link
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <EmptyState icon={MailOpen} title="Nenhuma mensagem aberta" />
          )}
        </section>
      </div>
    </section>
  );
}

function MediaPage() {
  const [folders, setFolders] = useState([]);
  const [media, setMedia] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [folderName, setFolderName] = useState('');
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState(null);

  const loadFolders = useCallback(async () => {
    const payload = await api('/image-folders');
    setFolders(payload.folders);
  }, []);

  const loadMedia = useCallback(async () => {
    const query = selectedFolderId ? `?folderId=${encodeURIComponent(selectedFolderId)}` : '';
    const payload = await api(`/images${query}`);
    setMedia(payload.images);
  }, [selectedFolderId]);

  useEffect(() => {
    loadFolders().catch((error) => setMessage(error.message));
  }, [loadFolders]);

  useEffect(() => {
    loadMedia().catch((error) => setMessage(error.message));
  }, [loadMedia]);

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
      setMessage(files.length > 1 ? 'Midias enviadas.' : 'Midia enviada.');
      await Promise.all([loadFolders(), loadMedia()]);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  async function deleteMedia(mediaId) {
    await api(`/images/${mediaId}`, { method: 'DELETE' });
    if (selectedMedia?.id === mediaId) setSelectedMedia(null);
    setMessage('Midia removida.');
    await Promise.all([loadFolders(), loadMedia()]);
  }

  async function deleteFolder(folderId) {
    await api(`/image-folders/${folderId}`, { method: 'DELETE' });
    if (selectedFolderId === folderId) setSelectedFolderId('');
    setMessage('Pasta removida.');
    await Promise.all([loadFolders(), loadMedia()]);
  }

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);
  const imageCount = media.filter(isImageMedia).length;
  const videoCount = media.filter(isVideoMedia).length;
  const fileCount = media.filter(isFileMedia).length;

  return (
    <section className="page">
      <PageHeader eyebrow="Biblioteca compartilhada" title="Midia" />
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
                  <Film size={17} />
                  <span>{folder.name}</span>
                  <small>{folder.mediaCount ?? folder.imageCount}</small>
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
              <small>{media.length} arquivo(s) - {imageCount} imagem(ns) - {videoCount} video(s) - {fileCount} anexo(s)</small>
            </div>
            <label className="upload-button">
              <Upload size={17} />
              {uploading ? 'Enviando' : 'Enviar'}
              <input type="file" multiple onChange={uploadFiles} />
            </label>
          </div>
          <div className="image-grid">
            {media.map((item) => (
              <article className="image-card" key={item.id}>
                <button className="media-thumb" onClick={() => setSelectedMedia(item)}>
                  {isVideoMedia(item) ? (
                    <>
                      <video src={item.url} muted playsInline preload="metadata" />
                      <span className="media-type"><Film size={15} /> Video</span>
                    </>
                  ) : isImageMedia(item) ? (
                    <img src={item.url} alt="" />
                  ) : (
                    <span className="file-thumb">
                      <FileIcon size={38} />
                      <small>{getFileExtension(item.name)}</small>
                    </span>
                  )}
                </button>
                <span>
                  <strong>{item.name}</strong>
                  <small>{formatFileSize(item.sizeBytes)}</small>
                </span>
                <div className="card-actions">
                  <IconButton label="Abrir" onClick={() => setSelectedMedia(item)}>
                    <Maximize2 size={16} />
                  </IconButton>
                  <IconButton label="Copiar URL" onClick={() => copyText(item.url)}>
                    <Copy size={16} />
                  </IconButton>
                  <IconButton label="Remover midia" onClick={() => deleteMedia(item.id)}>
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </article>
            ))}
          </div>
          {media.length === 0 && <EmptyState icon={Film} title="Nenhuma midia nesta pasta" />}
        </section>
      </div>
      {selectedMedia && (
        <div className="media-viewer-backdrop" role="dialog" aria-modal="true">
          <section className="media-viewer">
            <div className="media-viewer-header">
              <span>
                <strong>{selectedMedia.name}</strong>
                <small>{formatFileSize(selectedMedia.sizeBytes)}</small>
              </span>
              <div className="card-actions">
                <IconButton label="Copiar URL" onClick={() => copyText(selectedMedia.url)}>
                  <Copy size={17} />
                </IconButton>
                <IconButton label="Fechar" onClick={() => setSelectedMedia(null)}>
                  <X size={17} />
                </IconButton>
              </div>
            </div>
            <div className="media-viewer-body">
              {isVideoMedia(selectedMedia) ? (
                <video src={selectedMedia.url} controls autoPlay playsInline />
              ) : isImageMedia(selectedMedia) ? (
                <img src={selectedMedia.url} alt={selectedMedia.name} />
              ) : (
                <div className="media-viewer-file">
                  <FileIcon size={54} />
                  <strong>{selectedMedia.name}</strong>
                  <small>{formatFileSize(selectedMedia.sizeBytes)}</small>
                  <a className="primary-button" href={selectedMedia.url} download={selectedMedia.name}>
                    <Download size={17} />
                    Baixar arquivo
                  </a>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

const discordSections = [
  { id: 'webhook', label: 'Webhook', icon: MessageSquare },
  { id: 'embed', label: 'Embed Builder', icon: Code2 },
  { id: 'bot', label: 'Bot Manager', icon: Bot },
  { id: 'channels', label: 'Canais', icon: Hash },
  { id: 'roles', label: 'Cargos', icon: Crown },
  { id: 'anti-nuke', label: 'Anti-Nuke', icon: Shield },
  { id: 'moderation', label: 'Moderacao', icon: Gavel },
  { id: 'lookup', label: 'User Lookup', icon: Search },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'settings', label: 'Configuracoes', icon: Settings }
];

const defaultDiscordEmbed = {
  title: '',
  description: '',
  color: '#ff4058',
  image: '',
  thumbnail: '',
  footer: '',
  fields: []
};

const defaultDiscordSettings = {
  prefix: '!',
  logChannelId: '',
  welcomeMessage: 'Bem-vindo ao servidor, {user}.',
  leaveMessage: '{user} saiu do servidor.',
  modules: {
    antiNuke: true,
    logs: true,
    moderation: true,
    welcome: false,
    webhookTools: true,
    channelManager: true,
    roleManager: true
  }
};

function discordColorToHex(value) {
  const number = Number(value || 0);
  return `#${number.toString(16).padStart(6, '0').slice(-6)}`;
}

function channelIcon(type) {
  if (type === 2) return Volume2;
  if (type === 4) return FolderPlus;
  return Hash;
}

function channelLabel(type) {
  if (type === 2) return 'Voz';
  if (type === 4) return 'Categoria';
  return 'Texto';
}

function makeDiscordEmbedJson(embed) {
  const fields = (embed.fields || [])
    .filter((field) => field.name || field.value)
    .map((field) => ({
      name: field.name || 'Campo',
      value: field.value || '-',
      inline: Boolean(field.inline)
    }));

  const payload = {};
  if (embed.title) payload.title = embed.title;
  if (embed.description) payload.description = embed.description;
  if (embed.color) payload.color = Number.parseInt(embed.color.replace('#', ''), 16) || 0xff4058;
  if (embed.image) payload.image = { url: embed.image };
  if (embed.thumbnail) payload.thumbnail = { url: embed.thumbnail };
  if (embed.footer) payload.footer = { text: embed.footer };
  if (fields.length) payload.fields = fields;
  return payload;
}

function DiscordEmbedPreview({ embed, content, username, avatarUrl }) {
  const hasEmbed = Boolean(embed.title || embed.description || embed.image || embed.thumbnail || embed.footer || embed.fields?.length);

  return (
    <div className="discord-message-preview">
      <div className="discord-message-author">
        <Avatar src={avatarUrl} name={username || 'Nexus'} />
        <span>
          <strong>{username || 'Nexus Webhook'}</strong>
          <small>Hoje as 21:15</small>
        </span>
      </div>
      {content && <p className="discord-preview-content">{content}</p>}
      {hasEmbed && (
        <div className="discord-embed-preview" style={{ '--embed-color': embed.color || '#ff4058' }}>
          {embed.thumbnail && <img className="discord-embed-thumb" src={embed.thumbnail} alt="" />}
          {embed.title && <strong>{embed.title}</strong>}
          {embed.description && <p>{embed.description}</p>}
          {embed.fields?.length > 0 && (
            <div className="discord-embed-fields">
              {embed.fields.filter((field) => field.name || field.value).map((field, index) => (
                <span key={`${field.name}-${index}`}>
                  <b>{field.name || 'Campo'}</b>
                  <small>{field.value || '-'}</small>
                </span>
              ))}
            </div>
          )}
          {embed.image && <img className="discord-embed-image" src={embed.image} alt="" />}
          {embed.footer && <small className="discord-embed-footer">{embed.footer}</small>}
        </div>
      )}
      {!content && !hasEmbed && <p className="muted">A preview aparece aqui conforme voce preenche.</p>}
    </div>
  );
}

function DiscordFieldEditor({ embed, setEmbed }) {
  function updateField(index, field, value) {
    setEmbed((current) => ({
      ...current,
      fields: current.fields.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item)
    }));
  }

  function addField() {
    setEmbed((current) => ({
      ...current,
      fields: [...current.fields, { name: '', value: '', inline: false }]
    }));
  }

  function removeField(index) {
    setEmbed((current) => ({
      ...current,
      fields: current.fields.filter((_, itemIndex) => itemIndex !== index)
    }));
  }

  return (
    <div className="discord-field-editor">
      <div className="panel-title compact">
        <h3>Campos personalizados</h3>
        <button className="ghost-button" type="button" onClick={addField}>
          <Plus size={16} />
          Campo
        </button>
      </div>
      {embed.fields.map((field, index) => (
        <div className="discord-field-row" key={index}>
          <input value={field.name} onChange={(event) => updateField(index, 'name', event.target.value)} placeholder="Nome do campo" />
          <input value={field.value} onChange={(event) => updateField(index, 'value', event.target.value)} placeholder="Valor" />
          <label className="switch-line">
            <input type="checkbox" checked={field.inline} onChange={(event) => updateField(index, 'inline', event.target.checked)} />
            Inline
          </label>
          <IconButton label="Remover campo" type="button" onClick={() => removeField(index)}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}
      {embed.fields.length === 0 && <p className="muted">Adicione campos quando quiser montar embeds maiores.</p>}
    </div>
  );
}

function DiscordToolsPage() {
  const savedSettings = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('nexus-discord-tools-settings') || 'null');
    } catch {
      return null;
    }
  }, []);
  const [section, setSection] = useState('webhook');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState('');
  const [webhook, setWebhook] = useState({ webhookUrl: '', content: '', username: '', avatarUrl: '' });
  const [embed, setEmbed] = useState(defaultDiscordEmbed);
  const [botConfig, setBotConfig] = useState({ botToken: '', guildId: savedSettings?.guildId || '' });
  const [botStatus, setBotStatus] = useState(null);
  const [channelForm, setChannelForm] = useState({ name: '', type: 0, parentId: '', channelId: '', position: '' });
  const [roleForm, setRoleForm] = useState({ name: '', color: '#ff4058', permissions: '0', roleId: '', userId: '', action: 'add' });
  const [antiNuke, setAntiNuke] = useState(savedSettings?.antiNuke || {
    enabled: true,
    limitPerMinute: 5,
    punishment: 'remove_roles',
    whitelist: '',
    ignoredRoles: '',
    logChannelId: savedSettings?.logChannelId || ''
  });
  const [moderation, setModeration] = useState({ userId: '', channelId: '', reason: '', durationMinutes: 10, amount: 10, message: '' });
  const [lookupId, setLookupId] = useState('');
  const [lookupResult, setLookupResult] = useState(null);
  const [logs, setLogs] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('nexus-discord-tools-logs') || '[]');
    } catch {
      return [];
    }
  });
  const [logFilters, setLogFilters] = useState({ type: '', user: '', date: '' });
  const [settings, setSettings] = useState(savedSettings || defaultDiscordSettings);

  const categories = useMemo(() => (botStatus?.channels || []).filter((channel) => channel.type === 4), [botStatus]);
  const visibleLogs = useMemo(() => logs.filter((log) => {
    const matchesType = !logFilters.type || log.type === logFilters.type;
    const matchesUser = !logFilters.user || String(log.user || '').includes(logFilters.user);
    const matchesDate = !logFilters.date || log.createdAt.startsWith(logFilters.date);
    return matchesType && matchesUser && matchesDate;
  }), [logs, logFilters]);

  function showNotice(message) {
    setNotice(message);
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => setNotice(''), 4200);
  }

  function pushLog(type, detail, user = '') {
    setLogs((current) => {
      const next = [{ id: crypto.randomUUID(), type, detail, user, createdAt: new Date().toISOString() }, ...current].slice(0, 120);
      localStorage.setItem('nexus-discord-tools-logs', JSON.stringify(next));
      return next;
    });
  }

  function updateWebhook(field, value) {
    setWebhook((current) => ({ ...current, [field]: value }));
  }

  function updateBot(field, value) {
    setBotConfig((current) => ({ ...current, [field]: value }));
  }

  function updateSettings(nextSettings) {
    setSettings(nextSettings);
    localStorage.setItem('nexus-discord-tools-settings', JSON.stringify(nextSettings));
  }

  async function runAction(key, action) {
    setLoading(key);
    setNotice('');
    try {
      await action();
    } catch (error) {
      showNotice(error.message);
    } finally {
      setLoading('');
    }
  }

  async function sendWebhookMessage() {
    await runAction('webhook', async () => {
      const result = await api('/discord-tools/webhook/send', {
        method: 'POST',
        body: { ...webhook, embed }
      });
      pushLog('webhook', `Mensagem enviada pelo webhook ${result.messageId || ''}`);
      showNotice('Mensagem enviada no Discord.');
    });
  }

  async function loadBotStatus() {
    await runAction('bot', async () => {
      const payload = await api('/discord-tools/bot/status', {
        method: 'POST',
        body: botConfig
      });
      setBotStatus(payload);
      const nextSettings = { ...settings, guildId: botConfig.guildId || payload.guild?.id || settings.guildId };
      updateSettings(nextSettings);
      if (!botConfig.guildId && payload.guild?.id) updateBot('guildId', payload.guild.id);
      pushLog('bot', `Status carregado para ${payload.guild?.name || 'bot'}`);
      showNotice('Bot conectado.');
    });
  }

  async function createChannel() {
    await runAction('channel', async () => {
      const payload = await api('/discord-tools/channels', {
        method: 'POST',
        body: { ...botConfig, ...channelForm }
      });
      pushLog('channel', `Canal criado: ${payload.channel.name}`);
      setChannelForm((current) => ({ ...current, name: '' }));
      await loadBotStatus();
    });
  }

  async function updateChannel() {
    if (!channelForm.channelId) return showNotice('Informe o ID do canal.');
    await runAction('channel-update', async () => {
      const payload = await api(`/discord-tools/channels/${channelForm.channelId}`, {
        method: 'PATCH',
        body: { ...botConfig, ...channelForm }
      });
      pushLog('channel', `Canal alterado: ${payload.channel.name}`);
      await loadBotStatus();
    });
  }

  async function deleteChannel(channelId = channelForm.channelId) {
    if (!channelId) return showNotice('Informe o ID do canal.');
    if (!window.confirm('Excluir este canal? Essa acao nao volta.')) return;
    await runAction('channel-delete', async () => {
      await api(`/discord-tools/channels/${channelId}`, { method: 'DELETE', body: botConfig });
      pushLog('channel', `Canal excluido: ${channelId}`);
      await loadBotStatus();
    });
  }

  async function createRole() {
    await runAction('role', async () => {
      const payload = await api('/discord-tools/roles', {
        method: 'POST',
        body: { ...botConfig, ...roleForm }
      });
      pushLog('role', `Cargo criado: ${payload.role.name}`);
      setRoleForm((current) => ({ ...current, name: '' }));
      await loadBotStatus();
    });
  }

  async function updateRole() {
    if (!roleForm.roleId) return showNotice('Informe o ID do cargo.');
    await runAction('role-update', async () => {
      const payload = await api(`/discord-tools/roles/${roleForm.roleId}`, {
        method: 'PATCH',
        body: { ...botConfig, ...roleForm }
      });
      pushLog('role', `Cargo alterado: ${payload.role.name}`);
      await loadBotStatus();
    });
  }

  async function deleteRole(roleId = roleForm.roleId) {
    if (!roleId) return showNotice('Informe o ID do cargo.');
    if (!window.confirm('Excluir este cargo?')) return;
    await runAction('role-delete', async () => {
      await api(`/discord-tools/roles/${roleId}`, { method: 'DELETE', body: botConfig });
      pushLog('role', `Cargo excluido: ${roleId}`);
      await loadBotStatus();
    });
  }

  async function setMemberRole(action = roleForm.action) {
    if (!roleForm.userId || !roleForm.roleId) return showNotice('Informe usuario e cargo.');
    await runAction('member-role', async () => {
      await api('/discord-tools/roles/member', {
        method: 'POST',
        body: { ...botConfig, ...roleForm, action }
      });
      pushLog('role', `${action === 'remove' ? 'Removido' : 'Adicionado'} cargo ${roleForm.roleId}`, roleForm.userId);
      showNotice('Cargo do usuario atualizado.');
    });
  }

  async function runModeration(action) {
    await runAction(`moderation-${action}`, async () => {
      await api('/discord-tools/moderation', {
        method: 'POST',
        body: { ...botConfig, ...moderation, action }
      });
      pushLog('moderation', `Acao executada: ${action}`, moderation.userId);
      showNotice('Acao de moderacao enviada.');
    });
  }

  async function lookupUser() {
    await runAction('lookup', async () => {
      const payload = await api('/discord-tools/user-lookup', {
        method: 'POST',
        body: { userId: lookupId, botToken: botConfig.botToken }
      });
      setLookupResult(payload.user);
      pushLog('lookup', `Lookup de usuario ${payload.user.id}`, payload.user.id);
      showNotice('Usuario consultado.');
    });
  }

  function copyEmbedJson() {
    copyText(JSON.stringify(makeDiscordEmbedJson(embed), null, 2));
    showNotice('JSON do embed copiado.');
  }

  function clearWebhook() {
    setWebhook({ webhookUrl: '', content: '', username: '', avatarUrl: '' });
    setEmbed(defaultDiscordEmbed);
    showNotice('Campos limpos.');
  }

  function saveAntiNuke() {
    updateSettings({ ...settings, antiNuke, logChannelId: antiNuke.logChannelId });
    pushLog('anti-nuke', `Anti-Nuke ${antiNuke.enabled ? 'ativo' : 'desativado'}`);
    showNotice('Anti-Nuke salvo localmente.');
  }

  function saveBotSettings() {
    updateSettings(settings);
    pushLog('settings', 'Configuracoes do bot salvas');
    showNotice('Configuracoes salvas.');
  }

  function renderWebhook() {
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Webhook Messenger</h3>
            <MessageSquare size={18} />
          </div>
          <div className="discord-form-grid">
            <label>
              URL do webhook
              <input value={webhook.webhookUrl} onChange={(event) => updateWebhook('webhookUrl', event.target.value)} placeholder="https://discord.com/api/webhooks/..." />
            </label>
            <label>
              Nome personalizado
              <input value={webhook.username} onChange={(event) => updateWebhook('username', event.target.value)} placeholder="Nexus Bot" />
            </label>
            <label>
              Avatar URL
              <input value={webhook.avatarUrl} onChange={(event) => updateWebhook('avatarUrl', event.target.value)} placeholder="https://..." />
            </label>
            <label className="wide">
              Mensagem
              <textarea value={webhook.content} onChange={(event) => updateWebhook('content', event.target.value)} rows={5} placeholder="Escreva a mensagem" />
            </label>
          </div>
          <div className="discord-form-grid">
            <label>
              Titulo do embed
              <input value={embed.title} onChange={(event) => setEmbed((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <label>
              Cor
              <input type="color" value={embed.color} onChange={(event) => setEmbed((current) => ({ ...current, color: event.target.value }))} />
            </label>
            <label className="wide">
              Descricao do embed
              <textarea value={embed.description} onChange={(event) => setEmbed((current) => ({ ...current, description: event.target.value }))} rows={4} />
            </label>
            <label>
              Imagem
              <input value={embed.image} onChange={(event) => setEmbed((current) => ({ ...current, image: event.target.value }))} placeholder="https://..." />
            </label>
            <label>
              Thumbnail
              <input value={embed.thumbnail} onChange={(event) => setEmbed((current) => ({ ...current, thumbnail: event.target.value }))} placeholder="https://..." />
            </label>
            <label className="wide">
              Footer
              <input value={embed.footer} onChange={(event) => setEmbed((current) => ({ ...current, footer: event.target.value }))} />
            </label>
          </div>
          <DiscordFieldEditor embed={embed} setEmbed={setEmbed} />
          <div className="card-actions">
            <button className="primary-button" onClick={sendWebhookMessage} disabled={loading === 'webhook'}>
              <Send size={17} />
              {loading === 'webhook' ? 'Enviando' : 'Enviar mensagem'}
            </button>
            <button className="ghost-button" onClick={clearWebhook}>
              <Trash2 size={17} />
              Limpar
            </button>
          </div>
        </section>
        <section className="panel discord-preview-panel">
          <div className="panel-title">
            <h3>Preview</h3>
            <Eye size={18} />
          </div>
          <DiscordEmbedPreview embed={embed} content={webhook.content} username={webhook.username} avatarUrl={webhook.avatarUrl} />
        </section>
      </div>
    );
  }

  function renderEmbedBuilder() {
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Embed Builder</h3>
            <Code2 size={18} />
          </div>
          <div className="discord-form-grid">
            <label>
              Cor do embed
              <input type="color" value={embed.color} onChange={(event) => setEmbed((current) => ({ ...current, color: event.target.value }))} />
            </label>
            <label>
              Titulo
              <input value={embed.title} onChange={(event) => setEmbed((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <label className="wide">
              Descricao
              <textarea rows={6} value={embed.description} onChange={(event) => setEmbed((current) => ({ ...current, description: event.target.value }))} />
            </label>
            <label>
              Imagem
              <input value={embed.image} onChange={(event) => setEmbed((current) => ({ ...current, image: event.target.value }))} />
            </label>
            <label>
              Thumbnail
              <input value={embed.thumbnail} onChange={(event) => setEmbed((current) => ({ ...current, thumbnail: event.target.value }))} />
            </label>
            <label className="wide">
              Footer
              <input value={embed.footer} onChange={(event) => setEmbed((current) => ({ ...current, footer: event.target.value }))} />
            </label>
          </div>
          <DiscordFieldEditor embed={embed} setEmbed={setEmbed} />
          <div className="card-actions">
            <button className="primary-button" onClick={copyEmbedJson}>
              <Copy size={17} />
              Copiar JSON
            </button>
            <button className="ghost-button" onClick={sendWebhookMessage} disabled={loading === 'webhook'}>
              <Send size={17} />
              Enviar pelo webhook
            </button>
          </div>
        </section>
        <section className="panel discord-preview-panel">
          <div className="panel-title">
            <h3>Preview em tempo real</h3>
            <Eye size={18} />
          </div>
          <DiscordEmbedPreview embed={embed} content={webhook.content} username={webhook.username} avatarUrl={webhook.avatarUrl} />
          <pre className="discord-json-preview">{JSON.stringify(makeDiscordEmbedJson(embed), null, 2)}</pre>
        </section>
      </div>
    );
  }

  function renderBotManager() {
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Bot Server Manager</h3>
            <Server size={18} />
          </div>
          <div className="notice subtle">Para ficar seguro, use DISCORD_BOT_TOKEN no Render. O campo abaixo e temporario e nao fica salvo.</div>
          <div className="discord-form-grid">
            <label>
              Token do bot
              <input type="password" value={botConfig.botToken} onChange={(event) => updateBot('botToken', event.target.value)} placeholder="Opcional se DISCORD_BOT_TOKEN estiver no backend" />
            </label>
            <label>
              ID do servidor
              <input value={botConfig.guildId} onChange={(event) => updateBot('guildId', event.target.value)} placeholder="Guild ID" />
            </label>
          </div>
          <button className="primary-button" onClick={loadBotStatus} disabled={loading === 'bot'}>
            <RefreshCw size={17} />
            {loading === 'bot' ? 'Conectando' : 'Carregar servidor'}
          </button>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Status do bot</h3>
            <Activity size={18} />
          </div>
          {botStatus ? (
            <>
              <div className="discord-status-hero">
                <Avatar src={botStatus.bot.avatarUrl} name={botStatus.bot.username} size="lg" />
                <span>
                  <strong>{botStatus.bot.username}</strong>
                  <small>{botStatus.bot.online ? 'Online' : 'Offline'} - {botStatus.bot.ping}ms - {botStatus.bot.guildCount} servidor(es)</small>
                </span>
              </div>
              <div className="discord-stat-grid">
                <Metric icon={Users} label="Membros" value={botStatus.guild?.memberCount || 0} />
                <Metric icon={Hash} label="Canais" value={botStatus.guild?.channelCount || 0} />
                <Metric icon={Crown} label="Cargos" value={botStatus.guild?.roleCount || 0} />
              </div>
              {botStatus.guild && (
                <div className="discord-server-card">
                  <Avatar src={botStatus.guild.iconUrl} name={botStatus.guild.name} />
                  <span>
                    <strong>{botStatus.guild.name}</strong>
                    <small>ID {botStatus.guild.id}</small>
                  </span>
                </div>
              )}
            </>
          ) : (
            <EmptyState icon={Bot} title="Bot ainda nao conectado" />
          )}
        </section>
      </div>
    );
  }

  function renderChannels() {
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Channel Manager</h3>
            <Hash size={18} />
          </div>
          <div className="discord-form-grid">
            <label>
              Nome
              <input value={channelForm.name} onChange={(event) => setChannelForm((current) => ({ ...current, name: event.target.value }))} placeholder="geral" />
            </label>
            <label>
              Tipo
              <select value={channelForm.type} onChange={(event) => setChannelForm((current) => ({ ...current, type: Number(event.target.value) }))}>
                <option value={0}>Texto</option>
                <option value={2}>Voz</option>
                <option value={4}>Categoria</option>
              </select>
            </label>
            <label>
              Categoria
              <select value={channelForm.parentId} onChange={(event) => setChannelForm((current) => ({ ...current, parentId: event.target.value }))}>
                <option value="">Sem categoria</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            <label>
              Posicao
              <input value={channelForm.position} onChange={(event) => setChannelForm((current) => ({ ...current, position: event.target.value }))} placeholder="0" />
            </label>
            <label className="wide">
              ID do canal para editar/excluir
              <input value={channelForm.channelId} onChange={(event) => setChannelForm((current) => ({ ...current, channelId: event.target.value }))} placeholder="Channel ID" />
            </label>
          </div>
          <div className="discord-permission-grid">
            {['Ver canal', 'Enviar mensagens', 'Conectar', 'Falar'].map((item) => (
              <label className="switch-line" key={item}>
                <input type="checkbox" defaultChecked />
                {item}
              </label>
            ))}
          </div>
          <div className="card-actions">
            <button className="primary-button" onClick={createChannel} disabled={loading === 'channel'}><Plus size={17} /> Criar</button>
            <button className="ghost-button" onClick={updateChannel} disabled={loading === 'channel-update'}><Save size={17} /> Salvar edicao</button>
            <button className="danger-button" onClick={() => deleteChannel()} disabled={loading === 'channel-delete'}><Trash2 size={17} /> Excluir</button>
          </div>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Canais do servidor</h3>
            <button className="ghost-button" onClick={loadBotStatus}><RefreshCw size={16} /> Atualizar</button>
          </div>
          <div className="discord-list">
            {(botStatus?.channels || []).map((channel) => {
              const Icon = channelIcon(channel.type);
              return (
                <article className="discord-list-item" key={channel.id}>
                  <button onClick={() => setChannelForm((current) => ({ ...current, channelId: channel.id, name: channel.name, type: channel.type, parentId: channel.parent_id || '', position: channel.position ?? '' }))}>
                    <Icon size={18} />
                    <span>
                      <strong>{channel.name}</strong>
                      <small>{channelLabel(channel.type)} - ID {channel.id}</small>
                    </span>
                  </button>
                  <IconButton label="Excluir canal" onClick={() => deleteChannel(channel.id)}>
                    <Trash2 size={15} />
                  </IconButton>
                </article>
              );
            })}
            {!botStatus && <EmptyState icon={Hash} title="Carregue o bot para listar canais" />}
          </div>
        </section>
      </div>
    );
  }

  function renderRoles() {
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Role Manager</h3>
            <Crown size={18} />
          </div>
          <div className="discord-form-grid">
            <label>
              Nome
              <input value={roleForm.name} onChange={(event) => setRoleForm((current) => ({ ...current, name: event.target.value }))} placeholder="Membro" />
            </label>
            <label>
              Cor
              <input type="color" value={roleForm.color} onChange={(event) => setRoleForm((current) => ({ ...current, color: event.target.value }))} />
            </label>
            <label>
              Permissoes
              <input value={roleForm.permissions} onChange={(event) => setRoleForm((current) => ({ ...current, permissions: event.target.value }))} placeholder="0" />
            </label>
            <label>
              ID do cargo
              <input value={roleForm.roleId} onChange={(event) => setRoleForm((current) => ({ ...current, roleId: event.target.value }))} />
            </label>
            <label className="wide">
              ID do usuario
              <input value={roleForm.userId} onChange={(event) => setRoleForm((current) => ({ ...current, userId: event.target.value }))} placeholder="Para adicionar/remover cargo" />
            </label>
          </div>
          <div className="discord-permission-grid">
            {['Administrador', 'Gerenciar servidor', 'Gerenciar cargos', 'Banir', 'Expulsar', 'Gerenciar canais'].map((item) => (
              <label className="switch-line" key={item}>
                <input type="checkbox" />
                {item}
              </label>
            ))}
          </div>
          <div className="card-actions">
            <button className="primary-button" onClick={createRole} disabled={loading === 'role'}><Plus size={17} /> Criar</button>
            <button className="ghost-button" onClick={updateRole} disabled={loading === 'role-update'}><Save size={17} /> Renomear/alterar</button>
            <button className="ghost-button" onClick={() => setMemberRole('add')}><Users size={17} /> Adicionar a usuario</button>
            <button className="ghost-button" onClick={() => setMemberRole('remove')}><X size={17} /> Remover de usuario</button>
            <button className="danger-button" onClick={() => deleteRole()}><Trash2 size={17} /> Excluir</button>
          </div>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Cargos</h3>
            <Crown size={18} />
          </div>
          <div className="discord-role-grid">
            {(botStatus?.roles || []).slice().reverse().map((role) => (
              <article className="discord-role-card" key={role.id} style={{ '--role-color': discordColorToHex(role.color) }}>
                <button onClick={() => setRoleForm((current) => ({ ...current, roleId: role.id, name: role.name, color: discordColorToHex(role.color), permissions: role.permissions || '0' }))}>
                  <span className="role-dot" />
                  <span>
                    <strong>{role.name}</strong>
                    <small>ID {role.id}</small>
                  </span>
                </button>
                <IconButton label="Excluir cargo" onClick={() => deleteRole(role.id)}>
                  <Trash2 size={15} />
                </IconButton>
              </article>
            ))}
            {!botStatus && <EmptyState icon={Crown} title="Carregue o bot para listar cargos" />}
          </div>
        </section>
      </div>
    );
  }

  function renderAntiNuke() {
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Anti-Nuke</h3>
            <AlertTriangle size={18} />
          </div>
          <div className="discord-status-banner">
            {antiNuke.enabled ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
            <span>
              <strong>{antiNuke.enabled ? 'Ativo' : 'Desativado'}</strong>
              <small>Monitor configurado para logs, limites e punicoes automaticas.</small>
            </span>
          </div>
          <div className="discord-form-grid">
            <label className="switch-line wide">
              <input type="checkbox" checked={antiNuke.enabled} onChange={(event) => setAntiNuke((current) => ({ ...current, enabled: event.target.checked }))} />
              Ativar protecao Anti-Nuke
            </label>
            <label>
              Limite por minuto
              <input type="number" min="1" max="60" value={antiNuke.limitPerMinute} onChange={(event) => setAntiNuke((current) => ({ ...current, limitPerMinute: Number(event.target.value) }))} />
            </label>
            <label>
              Punicao automatica
              <select value={antiNuke.punishment} onChange={(event) => setAntiNuke((current) => ({ ...current, punishment: event.target.value }))}>
                <option value="remove_roles">Remover cargos perigosos</option>
                <option value="ban">Banir usuario</option>
                <option value="kick">Expulsar usuario</option>
                <option value="alert">Apenas alertar</option>
              </select>
            </label>
            <label>
              Canal de logs
              <input value={antiNuke.logChannelId} onChange={(event) => setAntiNuke((current) => ({ ...current, logChannelId: event.target.value }))} placeholder="Channel ID" />
            </label>
            <label className="wide">
              Whitelist de usuarios confiaveis
              <textarea rows={3} value={antiNuke.whitelist} onChange={(event) => setAntiNuke((current) => ({ ...current, whitelist: event.target.value }))} placeholder="Um Discord ID por linha" />
            </label>
            <label className="wide">
              Cargos ignorados
              <textarea rows={3} value={antiNuke.ignoredRoles} onChange={(event) => setAntiNuke((current) => ({ ...current, ignoredRoles: event.target.value }))} placeholder="Um Role ID por linha" />
            </label>
          </div>
          <button className="primary-button" onClick={saveAntiNuke}><Save size={17} /> Salvar Anti-Nuke</button>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Status e eventos</h3>
            <Shield size={18} />
          </div>
          <div className="discord-stat-grid">
            <Metric icon={AlertTriangle} label="Acoes detectadas" value={logs.filter((log) => log.type === 'anti-nuke').length} />
            <Metric icon={Ban} label="Usuarios punidos" value={logs.filter((log) => log.type === 'moderation').length} />
          </div>
          <div className="discord-list">
            {logs.slice(0, 8).map((log) => (
              <article className="discord-log-row" key={log.id}>
                <span className={`discord-log-dot ${log.type}`} />
                <span>
                  <strong>{log.detail}</strong>
                  <small>{formatDate(log.createdAt)}</small>
                </span>
              </article>
            ))}
            {logs.length === 0 && <EmptyState icon={ScrollText} title="Nenhum log recente" />}
          </div>
        </section>
      </div>
    );
  }

  function renderModeration() {
    const ruleMessage = 'Leia as regras do servidor antes de participar. Respeito, seguranca e bom senso sao obrigatorios.';
    const punishmentMessage = `Usuario punido. Motivo: ${moderation.reason || 'violacao das regras'}.`;
    const welcomeEmbed = {
      ...embed,
      title: 'Bem-vindo',
      description: 'Seja bem-vindo ao servidor. Confira as regras e aproveite.',
      color: '#ff4058'
    };

    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Moderation Tools</h3>
            <Gavel size={18} />
          </div>
          <div className="discord-form-grid">
            <label>
              Usuario ID
              <input value={moderation.userId} onChange={(event) => setModeration((current) => ({ ...current, userId: event.target.value }))} />
            </label>
            <label>
              Canal ID
              <input value={moderation.channelId} onChange={(event) => setModeration((current) => ({ ...current, channelId: event.target.value }))} />
            </label>
            <label>
              Timeout
              <input type="number" min="1" value={moderation.durationMinutes} onChange={(event) => setModeration((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} />
            </label>
            <label>
              Mensagens para limpar
              <input type="number" min="1" max="100" value={moderation.amount} onChange={(event) => setModeration((current) => ({ ...current, amount: Number(event.target.value) }))} />
            </label>
            <label className="wide">
              Motivo
              <input value={moderation.reason} onChange={(event) => setModeration((current) => ({ ...current, reason: event.target.value }))} />
            </label>
            <label className="wide">
              Mensagem
              <textarea rows={4} value={moderation.message} onChange={(event) => setModeration((current) => ({ ...current, message: event.target.value }))} />
            </label>
          </div>
          <div className="discord-action-grid">
            <button className="danger-button" onClick={() => runModeration('ban')}><Ban size={17} /> Banir</button>
            <button className="danger-button" onClick={() => runModeration('kick')}><LogOut size={17} /> Expulsar</button>
            <button className="ghost-button" onClick={() => runModeration('timeout')}><Clock3 size={17} /> Silenciar</button>
            <button className="ghost-button" onClick={() => runModeration('untimeout')}><Check size={17} /> Remover timeout</button>
            <button className="ghost-button" onClick={() => runModeration('warn')}><AlertTriangle size={17} /> Enviar aviso</button>
            <button className="ghost-button" onClick={() => runModeration('clear')}><Trash2 size={17} /> Limpar mensagens</button>
          </div>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Geradores rapidos</h3>
            <Sparkles size={18} />
          </div>
          <div className="discord-action-grid">
            <button className="ghost-button" onClick={() => setModeration((current) => ({ ...current, message: ruleMessage }))}><Clipboard size={17} /> Mensagem de regras</button>
            <button className="ghost-button" onClick={() => setModeration((current) => ({ ...current, message: punishmentMessage }))}><Gavel size={17} /> Mensagem de punicao</button>
            <button className="ghost-button" onClick={() => setEmbed((current) => ({ ...current, title: 'Anuncio', description: moderation.message || 'Novo anuncio do servidor.', color: '#ff4058' }))}><Bell size={17} /> Embed de anuncio</button>
            <button className="ghost-button" onClick={() => setEmbed(welcomeEmbed)}><Users size={17} /> Embed boas-vindas</button>
          </div>
          <DiscordEmbedPreview embed={embed} content={moderation.message} username="Nexus Moderation" />
        </section>
      </div>
    );
  }

  function renderLookup() {
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>User Lookup</h3>
            <Search size={18} />
          </div>
          <div className="discord-form-grid">
            <label className="wide">
              Discord ID
              <input value={lookupId} onChange={(event) => setLookupId(event.target.value)} placeholder="1144781565839294604" />
            </label>
          </div>
          <button className="primary-button" onClick={lookupUser} disabled={loading === 'lookup'}>
            <Search size={17} />
            Buscar usuario
          </button>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Resultado</h3>
            <UserCog size={18} />
          </div>
          {lookupResult ? (
            <div className="discord-lookup-card">
              <Avatar src={lookupResult.avatarUrl} name={lookupResult.username || lookupResult.id} size="xl" />
              <span>
                <strong>{lookupResult.globalName || lookupResult.username || 'Usuario Discord'}</strong>
                <small>ID {lookupResult.id}</small>
                <small>Criada em {formatDate(lookupResult.createdAt)}</small>
                <small>Badges/flags publicas: {lookupResult.flags ?? 'nao disponivel'}</small>
                <small>Fonte: {lookupResult.source === 'bot' ? 'Bot API' : 'Snowflake'}</small>
              </span>
            </div>
          ) : (
            <EmptyState icon={Search} title="Nenhum usuario consultado" />
          )}
        </section>
      </div>
    );
  }

  function renderLogs() {
    return (
      <section className="panel discord-tool-card">
        <div className="panel-title">
          <h3>Server Logs</h3>
          <button className="danger-button" onClick={() => {
            setLogs([]);
            localStorage.removeItem('nexus-discord-tools-logs');
          }}>
            <Trash2 size={16} />
            Limpar logs
          </button>
        </div>
        <div className="discord-form-grid">
          <label>
            Tipo
            <select value={logFilters.type} onChange={(event) => setLogFilters((current) => ({ ...current, type: event.target.value }))}>
              <option value="">Todos</option>
              <option value="webhook">Webhook</option>
              <option value="bot">Bot</option>
              <option value="channel">Canais</option>
              <option value="role">Cargos</option>
              <option value="anti-nuke">Anti-Nuke</option>
              <option value="moderation">Moderacao</option>
              <option value="lookup">Lookup</option>
              <option value="settings">Config</option>
            </select>
          </label>
          <label>
            Usuario
            <input value={logFilters.user} onChange={(event) => setLogFilters((current) => ({ ...current, user: event.target.value }))} />
          </label>
          <label>
            Data
            <input type="date" value={logFilters.date} onChange={(event) => setLogFilters((current) => ({ ...current, date: event.target.value }))} />
          </label>
        </div>
        <div className="discord-log-table">
          {visibleLogs.map((log) => (
            <article className="discord-log-row" key={log.id}>
              <span className={`discord-log-dot ${log.type}`} />
              <span>
                <strong>{log.detail}</strong>
                <small>{log.type} {log.user ? `- ${log.user}` : ''}</small>
              </span>
              <small>{formatDate(log.createdAt)}</small>
            </article>
          ))}
          {visibleLogs.length === 0 && <EmptyState icon={ScrollText} title="Nenhum log encontrado" />}
        </div>
      </section>
    );
  }

  function renderBotSettings() {
    return (
      <section className="panel discord-tool-card">
        <div className="panel-title">
          <h3>Bot Settings</h3>
          <Settings size={18} />
        </div>
        <div className="discord-form-grid">
          <label>
            Prefixo
            <input value={settings.prefix} onChange={(event) => setSettings((current) => ({ ...current, prefix: event.target.value }))} />
          </label>
          <label>
            Canal de logs
            <input value={settings.logChannelId} onChange={(event) => setSettings((current) => ({ ...current, logChannelId: event.target.value }))} />
          </label>
          <label className="wide">
            Mensagem de boas-vindas
            <textarea rows={3} value={settings.welcomeMessage} onChange={(event) => setSettings((current) => ({ ...current, welcomeMessage: event.target.value }))} />
          </label>
          <label className="wide">
            Mensagem de saida
            <textarea rows={3} value={settings.leaveMessage} onChange={(event) => setSettings((current) => ({ ...current, leaveMessage: event.target.value }))} />
          </label>
        </div>
        <div className="discord-toggle-grid">
          {Object.entries(settings.modules).map(([key, value]) => (
            <label className="switch-line" key={key}>
              <input
                type="checkbox"
                checked={value}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  modules: { ...current.modules, [key]: event.target.checked }
                }))}
              />
              {key.replace(/([A-Z])/g, ' $1')}
            </label>
          ))}
        </div>
        <button className="primary-button" onClick={saveBotSettings}><Save size={17} /> Salvar configuracoes</button>
      </section>
    );
  }

  const renderers = {
    webhook: renderWebhook,
    embed: renderEmbedBuilder,
    bot: renderBotManager,
    channels: renderChannels,
    roles: renderRoles,
    'anti-nuke': renderAntiNuke,
    moderation: renderModeration,
    lookup: renderLookup,
    logs: renderLogs,
    settings: renderBotSettings
  };

  return (
    <section className="page discord-tools-page">
      <PageHeader
        eyebrow="Discord"
        title="Discord Tools"
        actions={(
          <button className="ghost-button" onClick={loadBotStatus}>
            <RefreshCw size={17} />
            Atualizar bot
          </button>
        )}
      />
      {notice && (
        <button className="toast discord-toast" onClick={() => setNotice('')}>
          {notice}
          <X size={16} />
        </button>
      )}
      <div className="discord-tools-layout">
        <aside className="discord-tools-sidebar">
          {discordSections.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </aside>
        <div className="discord-tools-content">
          {renderers[section]()}
        </div>
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

function SettingsPage({ theme, resolvedTheme, setTheme, onBackup }) {
  return (
    <section className="page">
      <PageHeader eyebrow="Preferencias" title="Configuracoes" />
      <div className="settings-grid">
        <section className="panel">
          <div className="panel-title">
            <h3>Tema</h3>
            <Sparkles size={18} />
          </div>
          <div className="segmented theme-segmented">
            <button className={theme === 'system' ? 'active' : ''} onClick={() => setTheme('system')}><Palette size={17} /> Sistema</button>
            <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}><Sun size={17} /> Claro</button>
            <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}><Moon size={17} /> Escuro</button>
          </div>
          <div className="theme-mobile-preview">
            <span><Palette size={16} /> Tema ativo</span>
            <strong>{resolvedTheme === 'dark' ? 'Escuro' : 'Claro'}</strong>
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

function isVideoMedia(item) {
  return item?.kind === 'video' || String(item?.mimeType || '').startsWith('video/');
}

function isImageMedia(item) {
  return item?.kind === 'image' || String(item?.mimeType || '').startsWith('image/');
}

function isFileMedia(item) {
  return !isImageMedia(item) && !isVideoMedia(item);
}

function getFileExtension(name = '') {
  const parts = String(name).split('.');
  const ext = parts.length > 1 ? parts.pop() : 'arquivo';
  return ext.slice(0, 8).toUpperCase();
}

function getRobloxStatusLabel(account) {
  if (account?.status === 'available') return 'Disponivel';
  return account?.presence?.label || 'Em uso';
}

function getRobloxStatusClass(account) {
  return account?.status === 'available' ? 'tag success' : 'tag warning';
}

function formatFileSize(bytes = 0) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(value / 1024))} KB`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Nao foi possivel ler a midia.'));
    reader.readAsDataURL(file);
  });
}

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Nao foi possivel ler o TXT.'));
    reader.readAsText(file);
  });
}

function formatRobloxGeneratorData(account) {
  return [
    `Login: ${account.username || ''}`,
    `Senha: ${account.password || ''}`,
    account.displayName ? `Display Name: ${account.displayName}` : '',
    account.userId ? `UserId: ${account.userId}` : '',
    account.profileUrl ? `Perfil: ${account.profileUrl}` : ''
  ].filter(Boolean).join('\n');
}

export default function App() {
  const [theme, setThemeState] = useState(() => localStorage.getItem('nexus-theme') || 'system');
  const [resolvedTheme, setResolvedTheme] = useState('dark');
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
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const nextTheme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = nextTheme;
      setResolvedTheme(nextTheme);
    };
    applyTheme();
    if (theme !== 'system') return undefined;
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
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

  const navigateView = useCallback((nextView) => {
    if (nextView === view) return;

    const changeView = () => setView(nextView);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (!reducedMotion && document.startViewTransition) {
      document.startViewTransition(changeView);
      return;
    }

    changeView();
  }, [view]);

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
    navigateView('details');
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
      resolvedTheme={resolvedTheme}
      onToggleTheme={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      onLogout={logout}
      view={view}
      setView={navigateView}
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
          setView={navigateView}
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
          onBack={() => navigateView('accounts')}
          onEdit={openEdit}
          onRefresh={refreshAll}
          onDeleted={async () => {
            setSelectedAccount(null);
            navigateView('accounts');
            await refreshAll();
          }}
        />
      )}
      {view === 'history' && <HistoryPage history={history} />}
      {view === 'roblox-generator' && <RobloxGeneratorPage user={session.user} />}
      {view === 'authenticator' && <AuthenticatorPage />}
      {view === 'temp-email' && <TempEmailPage />}
      {view === 'images' && <MediaPage />}
      {view === 'discord-tools' && <DiscordToolsPage />}
      {view === 'users' && <UsersPage users={authorizedUsers} reloadUsers={loadAuthorizedUsers} />}
      {view === 'settings' && <SettingsPage theme={theme} resolvedTheme={resolvedTheme} setTheme={setTheme} onBackup={exportBackup} />}
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
