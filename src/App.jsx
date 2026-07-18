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
                  <small>{account.platform} -À {formatDate(account.updatedAt)}</small>
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
                    <small>{share.discordId} -À {share.permission}</small>
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
                <small>{roblox.displayName} -À {roblox.userId}</small>
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
              {item.accountName ? `${item.accountName} -À ` : ''}
              {item.actorUsername || item.actorDiscordId || 'Sistema'} -À {formatDate(item.createdAt)}
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
  const [section, setSection] = useState('licenses');
  const [licenseUsers, setLicenseUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [releases, setReleases] = useState([]);
  const [loaderInfo, setLoaderInfo] = useState(null);
  const [filters, setFilters] = useState({ search: '', status: '', planId: '' });
  const [selectedUser, setSelectedUser] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [licenseForm, setLicenseForm] = useState({ discordId: '', planId: '', expiresAt: '', hwidResetLimit: '', status: 'active' });
  const [accessForm, setAccessForm] = useState({ discordId: '', role: 'member', label: '' });
  const [planForm, setPlanForm] = useState({ id: '', name: '', durationDays: '', defaultHwidResetLimit: 1 });
  const [releaseVersion, setReleaseVersion] = useState('');
  const [releaseLoading, setReleaseLoading] = useState(false);

  const loadPlans = useCallback(async () => {
    const payload = await api('/licenses/plans');
    setPlans(payload.plans);
    setLicenseForm((current) => ({ ...current, planId: current.planId || payload.plans.find((plan) => plan.active)?.id || '' }));
  }, []);

  const loadLicenseUsers = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (filters.search) query.set('search', filters.search);
      if (filters.status) query.set('status', filters.status);
      if (filters.planId) query.set('planId', filters.planId);
      const payload = await api(`/licenses/users?${query}`);
      setLicenseUsers(payload.users);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const loadReleases = useCallback(async () => {
    const payload = await api('/loader/releases');
    setReleases(payload.releases || []);
    setLoaderInfo(payload);
  }, []);

  useEffect(() => {
    loadPlans().catch((requestError) => setError(requestError.message));
    loadReleases().catch((requestError) => setError(requestError.message));
  }, [loadPlans, loadReleases]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadLicenseUsers().catch((requestError) => setError(requestError.message));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [loadLicenseUsers]);

  function requestBodyFromForm(form) {
    const body = {
      discordId: form.discordId,
      planId: form.planId,
      status: form.status
    };
    if (form.expiresAt) body.expiresAt = new Date(form.expiresAt).toISOString();
    if (form.hwidResetLimit !== '') body.hwidResetLimit = Number(form.hwidResetLimit);
    return body;
  }

  async function createLicense(event) {
    event.preventDefault();
    setError('');
    try {
      const payload = await api('/licenses/users', { method: 'POST', body: requestBodyFromForm(licenseForm) });
      setSelectedUser(payload.user);
      setShowCreate(false);
      setLicenseForm((current) => ({ ...current, discordId: '', expiresAt: '', hwidResetLimit: '', status: 'active' }));
      setMessage('Usuario e key criados com sucesso.');
      await loadLicenseUsers();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function openUser(userId) {
    setError('');
    try {
      const payload = await api(`/licenses/users/${userId}`);
      setSelectedUser(payload.user);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function updateSelected(patch, successMessage) {
    if (!selectedUser) return;
    try {
      const payload = await api(`/licenses/users/${selectedUser.id}`, { method: 'PATCH', body: patch });
      setSelectedUser((current) => ({ ...current, ...payload.user, events: current.events || [] }));
      setMessage(successMessage);
      setError('');
      await loadLicenseUsers();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function resetHwid() {
    try {
      const payload = await api(`/licenses/users/${selectedUser.id}/reset-hwid`, { method: 'POST' });
      setSelectedUser((current) => ({ ...current, ...payload.user, events: current.events || [] }));
      setMessage('HWID resetado. O proximo dispositivo sera vinculado automaticamente.');
      setError('');
      await loadLicenseUsers();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function regenerateKey() {
    if (!window.confirm('Gerar uma nova key invalida a key atual. Continuar?')) return;
    try {
      const payload = await api(`/licenses/users/${selectedUser.id}/regenerate-key`, { method: 'POST' });
      setSelectedUser((current) => ({ ...current, ...payload.user, events: current.events || [] }));
      setMessage('Nova key gerada.');
      setError('');
      await loadLicenseUsers();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function deleteLicense() {
    if (!window.confirm('Excluir permanentemente este usuario e seu historico de licenca?')) return;
    try {
      await api(`/licenses/users/${selectedUser.id}`, { method: 'DELETE' });
      setSelectedUser(null);
      setMessage('Usuario licenciado excluido.');
      await loadLicenseUsers();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function savePlan(event) {
    event.preventDefault();
    const body = {
      name: planForm.name,
      durationDays: planForm.durationDays === '' ? null : Number(planForm.durationDays),
      defaultHwidResetLimit: Number(planForm.defaultHwidResetLimit)
    };
    try {
      if (planForm.id) await api(`/licenses/plans/${planForm.id}`, { method: 'PATCH', body });
      else await api('/licenses/plans', { method: 'POST', body });
      setPlanForm({ id: '', name: '', durationDays: '', defaultHwidResetLimit: 1 });
      setMessage(planForm.id ? 'Plano atualizado.' : 'Plano criado.');
      await loadPlans();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function deletePlan(planId) {
    if (!window.confirm('Excluir este plano?')) return;
    try {
      await api(`/licenses/plans/${planId}`, { method: 'DELETE' });
      await loadPlans();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function uploadRelease(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.lua')) {
      setError('Selecione um arquivo .lua.');
      return;
    }
    setReleaseLoading(true);
    setError('');
    try {
      const source = await file.text();
      const version = releaseVersion.trim() || `v${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
      const payload = await api('/loader/releases', {
        method: 'POST',
        body: { version, source, protectedMode: true }
      });
      setReleaseVersion('');
      setMessage(`Versao ${payload.release.version} publicada. O link fixo ja aponta para ela.`);
      await loadReleases();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setReleaseLoading(false);
    }
  }

  async function activateRelease(releaseId) {
    try {
      await api(`/loader/releases/${releaseId}/activate`, { method: 'POST' });
      setMessage('Versao ativa atualizada. Tickets antigos foram invalidados.');
      await loadReleases();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function deleteRelease(releaseId) {
    if (!window.confirm('Excluir esta versao do loader?')) return;
    try {
      await api(`/loader/releases/${releaseId}`, { method: 'DELETE' });
      setMessage('Versao removida.');
      await loadReleases();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function submitAccess(event) {
    event.preventDefault();
    await api('/authorized-users', { method: 'POST', body: accessForm });
    setAccessForm({ discordId: '', role: 'member', label: '' });
    setMessage('Acesso ao painel salvo.');
    await reloadUsers();
  }

  async function removeAccess(discordId) {
    await api(`/authorized-users/${discordId}`, { method: 'DELETE' });
    setMessage('Acesso ao painel removido.');
    await reloadUsers();
  }

  const stats = useMemo(() => ({
    total: licenseUsers.length,
    active: licenseUsers.filter((user) => user.status === 'active').length,
    suspended: licenseUsers.filter((user) => user.status === 'suspended').length,
    expired: licenseUsers.filter((user) => user.status === 'expired').length
  }), [licenseUsers]);

  const statusLabel = { active: 'Ativa', suspended: 'Suspensa', revoked: 'Revogada', expired: 'Expirada' };

  return (
    <section className="page license-admin-page">
      <PageHeader
        eyebrow="Nexus Access"
        title="Painel de usuarios"
        actions={section === 'licenses' && (
          <>
            <button className="ghost-button" onClick={() => setShowPlans(true)}><Crown size={17} /> Planos</button>
            <button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} /> Novo usuario</button>
          </>
        )}
      />
      {(message || error) && (
        <button className={`notice ${error ? 'danger' : 'success'}`} onClick={() => { setMessage(''); setError(''); }}>
          {error || message}
        </button>
      )}

      <div className="license-section-tabs">
        <button className={section === 'licenses' ? 'active' : ''} onClick={() => setSection('licenses')}><KeyRound size={17} /> Licencas</button>
        <button className={section === 'loader' ? 'active' : ''} onClick={() => setSection('loader')}><ShieldCheck size={17} /> Loader protegido</button>
        <button className={section === 'access' ? 'active' : ''} onClick={() => setSection('access')}><Shield size={17} /> Acesso ao painel</button>
      </div>

      {section === 'licenses' && (
        <>
          <div className="license-metrics">
            <Metric icon={Users} label="Usuarios" value={stats.total} />
            <Metric icon={BadgeCheck} label="Ativas" value={stats.active} />
            <Metric icon={Ban} label="Suspensas" value={stats.suspended} />
            <Metric icon={Clock3} label="Expiradas" value={stats.expired} />
          </div>
          <section className="panel license-toolbar">
            <label className="search-box">
              <Search size={18} />
              <input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Nome, Discord ID, key ou HWID" />
            </label>
            <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
              <option value="">Todos os status</option>
              <option value="active">Ativas</option>
              <option value="suspended">Suspensas</option>
              <option value="expired">Expiradas</option>
              <option value="revoked">Revogadas</option>
            </select>
            <select value={filters.planId} onChange={(event) => setFilters((current) => ({ ...current, planId: event.target.value }))}>
              <option value="">Todos os planos</option>
              {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
            </select>
            <IconButton label="Atualizar" onClick={() => loadLicenseUsers()}><RefreshCw size={18} /></IconButton>
          </section>

          <section className="panel license-list-panel">
            <div className="license-list-head">
              <span>Usuario</span><span>Licenca</span><span>HWID</span><span>Ultimo uso</span><span>Status</span><span />
            </div>
            <div className="license-user-list">
              {loading && <div className="license-empty"><RefreshCw className="spin" size={22} /> Carregando usuarios</div>}
              {!loading && licenseUsers.length === 0 && <div className="license-empty"><Users size={22} /> Nenhum usuario encontrado</div>}
              {!loading && licenseUsers.map((user) => (
                <button className="license-user-row" key={user.id} onClick={() => openUser(user.id)}>
                  <span className="license-user-identity">
                    <Avatar src={user.discordAvatarUrl} name={user.discordGlobalName || user.discordUsername || user.discordId} />
                    <span><strong>{user.discordGlobalName || user.discordUsername || 'Discord nao consultado'}</strong><small>{user.discordId}</small></span>
                  </span>
                  <span><strong>{user.plan.name}</strong><small>{user.keyPreview}</small></span>
                  <span><strong>{user.hwid ? 'Vinculado' : 'Livre'}</strong><small>{user.hwid || 'Aguardando primeiro uso'}</small></span>
                  <span><strong>{formatDate(user.lastUsedAt)}</strong><small>{user.lastLoaderVersion || 'Sem versao'}</small></span>
                  <span className={`license-status ${user.status}`}>{statusLabel[user.status]}</span>
                  <ChevronRight size={18} />
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {section === 'access' && (
        <>
          <section className="panel">
            <div className="panel-title"><div><h3>Acesso administrativo</h3><p className="muted">Controla quem pode entrar neste painel pelo Discord OAuth2.</p></div><ShieldCheck size={20} /></div>
            <form className="user-form" onSubmit={submitAccess}>
              <input value={accessForm.discordId} onChange={(event) => setAccessForm((current) => ({ ...current, discordId: event.target.value }))} placeholder="Discord ID" required />
              <input value={accessForm.label} onChange={(event) => setAccessForm((current) => ({ ...current, label: event.target.value }))} placeholder="Apelido" />
              <select value={accessForm.role} onChange={(event) => setAccessForm((current) => ({ ...current, role: event.target.value }))}>
                <option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option>
              </select>
              <button className="primary-button"><Plus size={17} /> Autorizar</button>
            </form>
          </section>
          <div className="user-grid">
            {users.map((user) => (
              <article className="user-card" key={user.discordId}>
                <Avatar src={user.avatarUrl} name={user.globalName || user.username || user.label} />
                <span><strong>{user.globalName || user.username || user.label}</strong><small>{user.discordId}</small></span>
                <span className="tag"><Shield size={15} /> {user.role}</span>
                <small>Ultimo login: {formatDate(user.lastLoginAt)}</small>
                <IconButton label="Remover" onClick={() => removeAccess(user.discordId)}><Trash2 size={17} /></IconButton>
              </article>
            ))}
          </div>
        </>
      )}

      {section === 'loader' && (
        <>
          <section className="panel loader-publish-card">
            <div className="panel-title">
              <div><p className="eyebrow">Source protegido</p><h3>Publicar nova versao</h3><p className="muted">O arquivo fica cifrado no servidor. O link publico nunca mostra o source original.</p></div>
              <ShieldCheck size={23} />
            </div>
            <div className="loader-publish-form">
              <label>Versao<input value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="v3.2.0" /></label>
              <label className="upload-button loader-file-button">
                <Upload size={17} /> {releaseLoading ? 'Publicando...' : 'Selecionar script .lua'}
                <input type="file" accept=".lua,text/x-lua" onChange={uploadRelease} disabled={releaseLoading} />
              </label>
            </div>
            <p className="loader-security-note"><FileIcon size={15} /> Upload maximo de 8 MB - AES-256-GCM em repouso - entrega por ticket unico de 45 segundos</p>
          </section>

          <section className="panel loader-link-card">
            <div className="panel-title"><div><p className="eyebrow">Link fixo</p><h3>Loader do Nexus</h3><p className="muted">Esse endereco permanece igual quando voce publica outra versao.</p></div><Code2 size={21} /></div>
            <div className="loader-link-row"><code>{loaderInfo?.bootstrapUrl || `${window.location.origin}/loader/nexus.lua`}</code><IconButton label="Copiar URL do loader" onClick={() => copyText(loaderInfo?.bootstrapUrl || `${window.location.origin}/loader/nexus.lua`)}><Copy size={17} /></IconButton></div>
            <div className="loader-link-row"><code>{loaderInfo?.loadstring || `loadstring(game:HttpGet("${window.location.origin}/loader/nexus.lua"))()`}</code><IconButton label="Copiar loadstring" onClick={() => copyText(loaderInfo?.loadstring || `loadstring(game:HttpGet("${window.location.origin}/loader/nexus.lua"))()`)}><Copy size={17} /></IconButton></div>
          </section>

          <section className="panel loader-releases-panel">
            <div className="panel-title"><div><h3>Versoes publicadas</h3><p className="muted">Somente uma versao fica ativa por vez.</p></div><RefreshCw size={18} /></div>
            <div className="loader-release-list">
              {releases.length === 0 && <div className="license-empty"><Upload size={22} /> Nenhum script publicado ainda</div>}
              {releases.map((release) => (
                <article className={`loader-release-card ${release.active ? 'active' : ''}`} key={release.id}>
                  <span className="loader-release-icon"><Code2 size={19} /></span>
                  <span className="loader-release-meta"><strong>{release.version}</strong><small>{release.bytes.toLocaleString('pt-BR')} bytes - SHA-256 {release.sha256.slice(0, 16)}... - {formatDate(release.createdAt)}</small></span>
                  <span className={`license-status ${release.active ? 'active' : 'expired'}`}>{release.active ? 'Ativa' : 'Inativa'}</span>
                  {!release.active && <button className="ghost-button compact-button" onClick={() => activateRelease(release.id)}>Ativar</button>}
                  {!release.active && <IconButton label="Excluir versao" onClick={() => deleteRelease(release.id)}><Trash2 size={16} /></IconButton>}
                </article>
              ))}
            </div>
          </section>
        </>
      )}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form className="modal license-form-modal" onSubmit={createLicense} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header"><div><p className="eyebrow">Nova licenca</p><h3>Adicionar usuario</h3></div><IconButton label="Fechar" type="button" onClick={() => setShowCreate(false)}><X size={18} /></IconButton></div>
            <label>Discord ID<input value={licenseForm.discordId} onChange={(event) => setLicenseForm((current) => ({ ...current, discordId: event.target.value }))} placeholder="123456789012345678" required /></label>
            <div className="form-grid">
              <label>Plano<select value={licenseForm.planId} onChange={(event) => setLicenseForm((current) => ({ ...current, planId: event.target.value }))} required>{plans.filter((plan) => plan.active).map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>
              <label>Limite de resets<input type="number" min="0" max="100" value={licenseForm.hwidResetLimit} onChange={(event) => setLicenseForm((current) => ({ ...current, hwidResetLimit: event.target.value }))} placeholder="Padrao do plano" /></label>
            </div>
            <label>Expiracao personalizada<input type="datetime-local" value={licenseForm.expiresAt} onChange={(event) => setLicenseForm((current) => ({ ...current, expiresAt: event.target.value }))} /><small>Deixe vazio para usar a duracao do plano.</small></label>
            <div className="modal-actions"><button type="button" className="ghost-button" onClick={() => setShowCreate(false)}>Cancelar</button><button className="primary-button"><KeyRound size={17} /> Gerar key</button></div>
          </form>
        </div>
      )}

      {showPlans && (
        <div className="modal-backdrop" onMouseDown={() => setShowPlans(false)}>
          <section className="modal license-plans-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header"><div><p className="eyebrow">Licenciamento</p><h3>Planos</h3></div><IconButton label="Fechar" onClick={() => setShowPlans(false)}><X size={18} /></IconButton></div>
            <form className="plan-form" onSubmit={savePlan}>
              <input value={planForm.name} onChange={(event) => setPlanForm((current) => ({ ...current, name: event.target.value }))} placeholder="Nome do plano" required />
              <input type="number" min="1" value={planForm.durationDays} onChange={(event) => setPlanForm((current) => ({ ...current, durationDays: event.target.value }))} placeholder="Dias (vazio = lifetime)" />
              <input type="number" min="0" max="100" value={planForm.defaultHwidResetLimit} onChange={(event) => setPlanForm((current) => ({ ...current, defaultHwidResetLimit: event.target.value }))} placeholder="Resets" />
              <button className="primary-button"><Save size={16} /> {planForm.id ? 'Salvar' : 'Criar'}</button>
            </form>
            <div className="plan-list">
              {plans.map((plan) => (
                <article className="plan-card" key={plan.id}>
                  <span className="plan-icon"><Crown size={19} /></span>
                  <span><strong>{plan.name}</strong><small>{plan.durationDays == null ? 'Lifetime' : `${plan.durationDays} dias`} · {plan.defaultHwidResetLimit} resets · {plan.userCount} usuarios</small></span>
                  <IconButton label="Editar" onClick={() => setPlanForm({ id: plan.id, name: plan.name, durationDays: plan.durationDays ?? '', defaultHwidResetLimit: plan.defaultHwidResetLimit })}><SlidersHorizontal size={16} /></IconButton>
                  <IconButton label="Excluir" onClick={() => deletePlan(plan.id)}><Trash2 size={16} /></IconButton>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {selectedUser && (
        <div className="license-drawer-backdrop" onMouseDown={() => setSelectedUser(null)}>
          <aside className="license-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <div className="license-drawer-header">
              <div className="license-profile-heading"><Avatar src={selectedUser.discordAvatarUrl} name={selectedUser.discordGlobalName || selectedUser.discordUsername || selectedUser.discordId} size="xl" /><span><p className="eyebrow">Perfil Discord</p><h3>{selectedUser.discordGlobalName || selectedUser.discordUsername || 'Usuario Discord'}</h3><small>@{selectedUser.discordUsername || selectedUser.discordId}</small></span></div>
              <IconButton label="Fechar" onClick={() => setSelectedUser(null)}><X size={19} /></IconButton>
            </div>
            <div className="license-drawer-scroll">
              <div className="license-profile-tags"><span className={`license-status ${selectedUser.status}`}>{statusLabel[selectedUser.status]}</span><span className="tag"><Crown size={14} /> {selectedUser.plan.name}</span><span className="tag">Discord {selectedUser.discordId}</span></div>
              <section className="license-detail-card key-card">
                <div><p className="eyebrow">Key unica</p><strong>{selectedUser.licenseKey || selectedUser.keyPreview}</strong></div>
                <IconButton label="Copiar key" onClick={() => copyText(selectedUser.licenseKey)}><Copy size={18} /></IconButton>
              </section>
              <div className="license-detail-grid">
                <section className="license-detail-card"><Hash size={18} /><span><small>HWID vinculado</small><strong title={selectedUser.hwid || ''}>{selectedUser.hwid || 'Aguardando primeiro uso'}</strong></span></section>
                <section className="license-detail-card"><Clock3 size={18} /><span><small>Expiracao</small><strong>{selectedUser.expiresAt ? formatDate(selectedUser.expiresAt) : 'Lifetime'}</strong></span></section>
                <section className="license-detail-card"><Activity size={18} /><span><small>Ultima utilizacao</small><strong>{formatDate(selectedUser.lastUsedAt)}</strong></span></section>
                <section className="license-detail-card"><Server size={18} /><span><small>IP aproximado</small><strong>{selectedUser.lastIpApprox || 'Nunca utilizado'}</strong></span></section>
                <section className="license-detail-card"><Code2 size={18} /><span><small>Versao do loader</small><strong>{selectedUser.lastLoaderVersion || 'Nao informada'}</strong></span></section>
                <section className="license-detail-card"><RefreshCw size={18} /><span><small>Resets de HWID</small><strong>{selectedUser.hwidResetCount} / {selectedUser.hwidResetLimit}</strong></span></section>
              </div>
              {selectedUser.suspiciousScore > 0 && <div className="notice warning"><AlertTriangle size={17} /> Risco {selectedUser.suspiciousScore}% · {selectedUser.suspiciousReason}</div>}
              <section className="license-edit-card">
                <div className="panel-title compact"><h3>Editar licenca</h3><SlidersHorizontal size={17} /></div>
                <div className="form-grid">
                  <label className="span-2">Discord ID<input value={selectedUser.discordId} onChange={(event) => setSelectedUser((current) => ({ ...current, discordId: event.target.value }))} onBlur={() => updateSelected({ discordId: selectedUser.discordId }, 'Discord atualizado.')} /></label>
                  <label>Plano<select value={selectedUser.plan.id} onChange={(event) => updateSelected({ planId: event.target.value }, 'Plano atualizado.')}>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>
                  <label>Status<select value={selectedUser.status} onChange={(event) => updateSelected({ status: event.target.value }, 'Status atualizado.')}><option value="active">Ativa</option><option value="suspended">Suspensa</option><option value="revoked">Revogada</option><option value="expired">Expirada</option></select></label>
                  <label>Limite de resets<input type="number" min="0" max="100" value={selectedUser.hwidResetLimit} onChange={(event) => setSelectedUser((current) => ({ ...current, hwidResetLimit: event.target.value }))} onBlur={() => updateSelected({ hwidResetLimit: Number(selectedUser.hwidResetLimit) }, 'Limite atualizado.')} /></label>
                  <label>Expiracao<input type="datetime-local" value={selectedUser.expiresAt ? new Date(selectedUser.expiresAt).toISOString().slice(0, 16) : ''} onChange={(event) => updateSelected({ expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null }, 'Expiracao atualizada.')} /></label>
                </div>
              </section>
              <section className="license-actions-grid">
                <button className="ghost-button" onClick={resetHwid} disabled={selectedUser.hwidResetCount >= selectedUser.hwidResetLimit}><RefreshCw size={17} /> Resetar HWID</button>
                <button className="ghost-button" onClick={regenerateKey}><KeyRound size={17} /> Gerar nova key</button>
                <button className="ghost-button" onClick={() => updateSelected({ status: selectedUser.status === 'suspended' ? 'active' : 'suspended' }, selectedUser.status === 'suspended' ? 'Licenca reativada.' : 'Licenca suspensa.')}><Ban size={17} /> {selectedUser.status === 'suspended' ? 'Reativar' : 'Suspender'}</button>
                <button className="danger-button" onClick={deleteLicense}><Trash2 size={17} /> Excluir usuario</button>
              </section>
              <section className="license-activity">
                <div className="panel-title compact"><h3>Atividade recente</h3><Activity size={17} /></div>
                {(selectedUser.events || []).length === 0 && <p className="muted">Nenhum evento registrado.</p>}
                {(selectedUser.events || []).map((event) => <div className="license-event" key={event.id}><span className={`event-dot ${event.type.includes('mismatch') || event.type.includes('suspended') ? 'danger' : ''}`} /><span><strong>{event.type.replaceAll('_', ' ')}</strong><small>{formatDate(event.createdAt)} · {event.ipApprox || 'IP desconhecido'} · {event.loaderVersion || 'sem versao'}</small></span></div>)}
              </section>
            </div>
          </aside>
        </div>
      )}
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
  { id: 'overview', label: 'Control Center', icon: LayoutDashboard },
  { id: 'runtime', label: 'Online e Agenda', icon: Activity },
  { id: 'voice', label: 'Voz', icon: Volume2 },
  { id: 'profile-control', label: 'Perfil do Bot', icon: Palette },
  { id: 'invite', label: 'Convite', icon: Share2 },
  { id: 'webhook', label: 'Webhook', icon: MessageSquare },
  { id: 'embed', label: 'Embed Builder', icon: Code2 },
  { id: 'bot', label: 'Bot Manager', icon: Bot },
  { id: 'commands', label: 'Comandos', icon: SlidersHorizontal },
  { id: 'channels', label: 'Canais', icon: Hash },
  { id: 'roles', label: 'Cargos', icon: Crown },
  { id: 'security', label: 'Seguranca', icon: ShieldCheck },
  { id: 'anti-nuke', label: 'Protecao', icon: Shield },
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

const defaultAntiNukeSettings = {
  enabled: true,
  limitPerMinute: 5,
  limitWindowSeconds: 60,
  punishment: 'remove_roles',
  timeoutMinutes: 1440,
  whitelist: '',
  ignoredRoles: '',
  ignoredChannels: '',
  notifyRoleIds: '',
  warnMessage: 'Sua mensagem violou as regras automaticas deste servidor.',
  logChannelId: '',
  quarantineRoleId: '',
  joinLimit: 8,
  joinWindowSeconds: 20,
  minAccountAgeDays: 7,
  messageLimit: 6,
  messageWindowSeconds: 12,
  duplicateMessageLimit: 4,
  mentionLimit: 4,
  inviteLimitPerMinute: 2,
  webhookLimitPerMinute: 2,
  verificationMode: 'medium',
  autoLockdown: true,
  blockInviteSpam: true,
  blockMentionSpam: true,
  backupChannels: true,
  backupRoles: true,
  autoRestore: true,
  detectors: {},
  notifyOwner: true
};

const defaultDiscordControl = {
  selectedBotId: 'render-bot',
  desiredStatus: 'online',
  maintenanceMode: false,
  autoReconnect: true,
  statusRotation: true,
  schedulePreset: 'forever',
  customHours: 0,
  customMinutes: 30,
  customSeconds: 0,
  timerEndAction: 'idle',
  lastRestartAt: '',
  voiceChannelId: '',
  voiceDuration: 'forever',
  voiceHours: 0,
  voiceMinutes: 30,
  voiceAfkMode: true,
  voiceAutoReconnect: true,
  voiceConnected: false,
  voiceStayUntilStopped: true,
  voiceStartedAt: '',
  voiceVolume: 80,
  profileDisplayName: '',
  profileStatusText: '',
  profileActivityType: 'Watching',
  profileActivityMessage: 'Nexus dashboard',
  profileAvatarUrl: '',
  profileBannerUrl: '',
  counterTargetType: 'bot-nickname',
  counterTargetId: '',
  counterTemplate: 'Membros: {members}',
  counterIntervalMinutes: 5,
  counterAuto: false,
  invitePermissions: '8',
  inviteGuildId: '',
  inviteClientId: '',
  inviteIncludeCommands: true,
  inviteDisableGuildSelect: false,
  commandCooldown: 5,
  commandRole: '',
  commandChannel: '',
  commandConfig: {}
};

const defaultDiscordManagedBots = [
  {
    id: 'render-bot',
    name: 'Render Bot',
    applicationId: '',
    guildId: '',
    avatarUrl: '',
    color: '#5865f2',
    desiredStatus: 'online',
    voiceChannelId: '',
    voiceDuration: 'forever',
    voiceConnected: false,
    voiceStartedAt: ''
  }
];

const discordStatusOptions = ['online', 'idle', 'dnd', 'invisible', 'offline'];
const discordSchedulePresets = [
  { id: '30m', label: '30 minutos' },
  { id: '1h', label: '1 hora' },
  { id: '6h', label: '6 horas' },
  { id: '24h', label: '24 horas' },
  { id: 'forever', label: 'Ate desligar' },
  { id: 'custom', label: 'Personalizado' }
];
const discordCommandCatalog = [
  { id: 'ban', label: 'Ban', category: 'Moderation', enabled: true },
  { id: 'kick', label: 'Kick', category: 'Moderation', enabled: true },
  { id: 'timeout', label: 'Timeout', category: 'Moderation', enabled: true },
  { id: 'clear', label: 'Clear messages', category: 'Moderation', enabled: true },
  { id: 'userinfo', label: 'User info', category: 'Utility', enabled: true },
  { id: 'serverinfo', label: 'Server info', category: 'Utility', enabled: true },
  { id: 'logs', label: 'Logs', category: 'Admin', enabled: true },
  { id: 'welcome', label: 'Welcome setup', category: 'Admin', enabled: false }
];

const discordInvitePresets = [
  { id: 'admin', label: 'Administrador completo', permissions: '8' },
  {
    id: 'protection',
    label: 'Protecao e moderacao',
    permissions: String(2n + 4n + 16n + 32n + 128n + 1024n + 2048n + 8192n + 268435456n + 536870912n + 1099511627776n)
  },
  {
    id: 'basic',
    label: 'Basico e comandos',
    permissions: String(1024n + 2048n + 64n + 16384n + 32768n + 65536n + 262144n + 1048576n + 2097152n)
  }
];

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

function extractApplicationIdFromBotCard(bot) {
  return bot?.applicationId || String(bot?.id || '').match(/^bot-(\d{5,32})/)?.[1] || '';
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

function hasDiscordEmbedContent(embed) {
  return Boolean(
    embed.title
    || embed.description
    || embed.image
    || embed.thumbnail
    || embed.footer
    || (embed.fields || []).some((field) => field.name || field.value)
  );
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
  const savedControl = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('nexus-discord-control-center') || 'null');
    } catch {
      return null;
    }
  }, []);
  const savedManagedBots = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('nexus-discord-managed-bots') || 'null');
    } catch {
      return null;
    }
  }, []);
  const [section, setSection] = useState('overview');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState('');
  const [webhook, setWebhook] = useState({ webhookUrl: '', content: '', username: '', avatarUrl: '' });
  const [repeatOptions, setRepeatOptions] = useState({ count: 100, delaySeconds: 1 });
  const [repeatStatus, setRepeatStatus] = useState({ active: false, sent: 0, total: 0 });
  const repeatStopRef = useRef(false);
  const [embed, setEmbed] = useState(defaultDiscordEmbed);
  const [botConfig, setBotConfig] = useState({ botToken: '', guildId: savedSettings?.guildId || '' });
  const [botStatus, setBotStatus] = useState(null);
  const [channelForm, setChannelForm] = useState({ name: '', type: 0, parentId: '', channelId: '', position: '' });
  const [roleForm, setRoleForm] = useState({ name: '', color: '#ff4058', permissions: '0', roleId: '', userId: '', action: 'add' });
  const [antiNuke, setAntiNuke] = useState({
    ...defaultAntiNukeSettings,
    ...(savedSettings?.antiNuke || {}),
    logChannelId: savedSettings?.antiNuke?.logChannelId || savedSettings?.logChannelId || ''
  });
  const [protectionCatalog, setProtectionCatalog] = useState({ categories: {}, detectors: [], defaults: {}, limitations: {} });
  const [protectionStats, setProtectionStats] = useState({ totals: { detections: 0, actions: 0 }, stats: [], events: [] });
  const [newBotForm, setNewBotForm] = useState({ token: '', guildId: '', name: '' });
  const [showAddBotModal, setShowAddBotModal] = useState(false);
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
  const [control, setControl] = useState({ ...defaultDiscordControl, ...(savedControl || {}) });
  const [managedBots, setManagedBots] = useState(() => {
    const bots = Array.isArray(savedManagedBots) && savedManagedBots.length ? savedManagedBots : defaultDiscordManagedBots;
    return bots.map((bot, index) => ({
      ...defaultDiscordManagedBots[0],
      ...bot,
      id: bot.id || `bot-${index + 1}`,
      guildId: bot.guildId || (index === 0 ? savedSettings?.guildId || '' : ''),
      desiredStatus: bot.desiredStatus || 'online',
      voiceDuration: bot.voiceDuration || 'forever'
    }));
  });
  const [botTokens, setBotTokens] = useState({});

  const selectedManagedBot = useMemo(() => (
    managedBots.find((bot) => bot.id === control.selectedBotId) || managedBots[0] || defaultDiscordManagedBots[0]
  ), [managedBots, control.selectedBotId]);
  const categories = useMemo(() => (botStatus?.channels || []).filter((channel) => channel.type === 4), [botStatus]);
  const voiceChannels = useMemo(() => (botStatus?.channels || []).filter((channel) => channel.type === 2), [botStatus]);
  const botCards = useMemo(() => managedBots.map((bot) => {
    const isSelected = bot.id === selectedManagedBot.id;
    return {
      ...bot,
      name: isSelected ? botStatus?.bot?.username || control.profileDisplayName || bot.name : bot.name,
      avatarUrl: isSelected ? botStatus?.bot?.avatarUrl || control.profileAvatarUrl || bot.avatarUrl : bot.avatarUrl,
      status: isSelected && botStatus?.bot?.online ? control.desiredStatus : bot.desiredStatus || 'offline',
      guildCount: isSelected ? botStatus?.bot?.guildCount || 0 : bot.guildCount || 0,
      ping: isSelected ? botStatus?.bot?.ping || 0 : bot.ping || 0,
      memberCount: isSelected ? botStatus?.guild?.memberCount || 0 : bot.memberCount || 0,
      onlineCount: isSelected ? botStatus?.guild?.onlineCount || 0 : bot.onlineCount || 0,
      voiceConnected: isSelected ? control.voiceConnected : bot.voiceConnected,
      uptime: bot.lastRestartAt ? formatDate(bot.lastRestartAt) : 'Nao reiniciado'
    };
  }), [managedBots, selectedManagedBot.id, botStatus, control]);
  const visibleLogs = useMemo(() => logs.filter((log) => {
    const matchesType = !logFilters.type || log.type === logFilters.type;
    const matchesUser = !logFilters.user || String(log.user || '').includes(logFilters.user);
    const matchesDate = !logFilters.date || log.createdAt.startsWith(logFilters.date);
    return matchesType && matchesUser && matchesDate;
  }), [logs, logFilters]);

  useEffect(() => () => {
    repeatStopRef.current = true;
  }, []);

  useEffect(() => {
    let active = true;
    api('/discord-tools/protection/catalog')
      .then((catalog) => {
        if (!active) return;
        setProtectionCatalog(catalog);
        setAntiNuke((current) => ({
          ...current,
          detectors: { ...(catalog.defaults || {}), ...(current.detectors || {}) }
        }));
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (section !== 'anti-nuke' || !botConfig.guildId) return;
    api(`/discord-tools/protection/stats?guildId=${encodeURIComponent(botConfig.guildId)}&limit=30`)
      .then(setProtectionStats)
      .catch(() => {});
  }, [section, botConfig.guildId]);

  useEffect(() => {
    setBotConfig((current) => {
      if (current.botToken || current.guildId) return current;
      return {
        botToken: botTokens[selectedManagedBot.id] || '',
        guildId: selectedManagedBot.guildId || ''
      };
    });
  }, [selectedManagedBot.id, selectedManagedBot.guildId, botTokens]);

  useEffect(() => {
    if (!control.counterAuto) return undefined;
    const minutes = Math.max(1, Math.min(60, Number(control.counterIntervalMinutes) || 5));
    const timer = window.setInterval(() => {
      void applyCounterNow(true);
    }, minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [
    control.counterAuto,
    control.counterIntervalMinutes,
    control.counterTargetType,
    control.counterTargetId,
    control.counterTemplate,
    botConfig.botToken,
    botConfig.guildId
  ]);

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

  function updateRepeatOption(field, value) {
    setRepeatOptions((current) => ({ ...current, [field]: value }));
  }

  function saveManagedBots(nextBots) {
    localStorage.setItem('nexus-discord-managed-bots', JSON.stringify(nextBots));
  }

  function updateManagedBot(botId, patch) {
    setManagedBots((current) => {
      const next = current.map((bot) => bot.id === botId ? { ...bot, ...patch } : bot);
      saveManagedBots(next);
      return next;
    });
  }

  function updateControl(patch) {
    setControl((current) => {
      const next = { ...current, ...patch };
      localStorage.setItem('nexus-discord-control-center', JSON.stringify(next));
      return next;
    });
  }

  function selectManagedBot(botId) {
    const nextBot = managedBots.find((bot) => bot.id === botId);
    if (!nextBot) return;
    updateControl({
      selectedBotId: botId,
      desiredStatus: nextBot.desiredStatus || 'online',
      voiceChannelId: nextBot.voiceChannelId || '',
      voiceDuration: nextBot.voiceDuration || 'forever',
      voiceConnected: Boolean(nextBot.voiceConnected),
      voiceStartedAt: nextBot.voiceStartedAt || '',
      voiceStayUntilStopped: nextBot.voiceDuration === 'forever'
    });
    setBotConfig({ botToken: botTokens[botId] || '', guildId: nextBot.guildId || '' });
    setBotStatus(null);
    showNotice(`Bot selecionado: ${nextBot.name}`);
  }

  function openAddBotModal() {
    setSection('bot');
    setShowAddBotModal(true);
    setNotice('');
  }

  function closeAddBotModal() {
    if (loading === 'bot-add') return;
    setShowAddBotModal(false);
  }

  async function addManagedBot() {
    const token = newBotForm.token.trim();
    if (!token) {
      setShowAddBotModal(true);
      return showNotice('Cole o token do bot para adicionar.');
    }

    await runAction('bot-add', async () => {
      const payload = await api('/discord-tools/bot/status', {
        method: 'POST',
        body: { botToken: token, guildId: newBotForm.guildId.trim() }
      });
      const baseId = `bot-${payload.bot?.id || crypto.randomUUID()}`;
      const id = managedBots.some((bot) => bot.id === baseId) ? `${baseId}-${Date.now()}` : baseId;
      const nextBot = {
        ...defaultDiscordManagedBots[0],
        id,
        name: newBotForm.name.trim() || payload.bot?.username || `Bot ${managedBots.length + 1}`,
        applicationId: payload.application?.id || payload.bot?.id || '',
        guildId: newBotForm.guildId.trim() || payload.guild?.id || '',
        guildName: payload.guild?.name || '',
        avatarUrl: payload.bot?.avatarUrl || '',
        color: '#23a55a',
        desiredStatus: payload.bot?.online ? control.desiredStatus : 'offline',
        guildCount: payload.bot?.guildCount || 0,
        memberCount: payload.guild?.memberCount || 0,
        onlineCount: payload.guild?.onlineCount || 0,
        channelCount: payload.guild?.channelCount || 0,
        roleCount: payload.guild?.roleCount || 0,
        ping: payload.bot?.ping || 0
      };
      setManagedBots((current) => {
        const next = [...current, nextBot];
        saveManagedBots(next);
        return next;
      });
      setBotTokens((current) => ({ ...current, [id]: token }));
      setBotStatus(payload);
      setBotConfig({ botToken: token, guildId: nextBot.guildId });
      setNewBotForm({ token: '', guildId: '', name: '' });
      setShowAddBotModal(false);
      updateControl({ selectedBotId: id, desiredStatus: nextBot.desiredStatus, voiceDuration: 'forever' });
      pushLog('bot', `Bot adicionado: ${nextBot.name}`, nextBot.guildName || nextBot.guildId);
      showNotice('Bot adicionado e validado pelo Discord.');
    });
  }

  function removeManagedBot(botId) {
    if (managedBots.length <= 1) return showNotice('Deixe pelo menos um bot no painel.');
    const next = managedBots.filter((bot) => bot.id !== botId);
    const fallback = next[0];
    setManagedBots(next);
    saveManagedBots(next);
    if (control.selectedBotId === botId && fallback) {
      updateControl({ selectedBotId: fallback.id });
      setBotConfig({ botToken: botTokens[fallback.id] || '', guildId: fallback.guildId || '' });
      setBotStatus(null);
    }
    showNotice('Bot removido do painel.');
  }

  function updateBot(field, value) {
    setBotConfig((current) => ({ ...current, [field]: value }));
    if (field === 'guildId') {
      updateManagedBot(control.selectedBotId, { guildId: value });
    }
    if (field === 'botToken') {
      setBotTokens((current) => ({ ...current, [control.selectedBotId]: value }));
    }
  }

  function updateSettings(nextSettings) {
    setSettings(nextSettings);
    localStorage.setItem('nexus-discord-tools-settings', JSON.stringify(nextSettings));
  }

  function updateCommandConfig(commandId, patch) {
    setControl((current) => {
      const nextCommand = {
        ...(current.commandConfig?.[commandId] || {}),
        ...patch
      };
      const next = {
        ...current,
        commandConfig: {
          ...(current.commandConfig || {}),
          [commandId]: nextCommand
        }
      };
      localStorage.setItem('nexus-discord-control-center', JSON.stringify(next));
      return next;
    });
  }

  async function runBotLifecycle(action) {
    const labels = {
      start: 'Start Bot',
      stop: 'Stop Bot',
      restart: 'Restart Bot',
      reconnect: 'Reconnect Bot'
    };
    const nextStatus = action === 'stop' ? 'offline' : control.desiredStatus || 'online';
    await runAction(`bot-${action}`, async () => {
      const result = await api('/discord-tools/bot/lifecycle', {
        method: 'POST',
        body: {
          ...botConfig,
          action,
          status: nextStatus,
          activityType: control.profileActivityType,
          activityMessage: control.profileActivityMessage || control.profileStatusText || 'Nexus dashboard'
        }
      });
      const restartedAt = action === 'restart' || action === 'reconnect' ? new Date().toISOString() : selectedManagedBot.lastRestartAt || '';
      updateControl({
        desiredStatus: nextStatus,
        lastRestartAt: restartedAt || control.lastRestartAt
      });
      updateManagedBot(control.selectedBotId, {
        desiredStatus: nextStatus,
        lastRestartAt: restartedAt,
        lastLifecycleAction: action,
        guildCount: result.runtime?.guildCount || selectedManagedBot.guildCount || 0,
        voiceConnected: Boolean(result.runtime?.voice?.length)
      });
      setBotStatus((current) => current ? { ...current, runtime: result.runtime, bot: { ...current.bot, online: Boolean(result.runtime?.online) } } : current);
      pushLog('bot', `${labels[action]} executado no Gateway`, selectedManagedBot.name);
      showNotice(`${labels[action]} executado no Discord Gateway.`);
    });
  }

  async function saveVoicePlan(action) {
    const channel = voiceChannels.find((item) => item.id === control.voiceChannelId);
    const isLeaving = action === 'Leave voice';
    if (!botConfig.guildId) return showNotice('Carregue ou informe o servidor primeiro.');
    if (!isLeaving && !control.voiceChannelId) return showNotice('Selecione um canal de voz.');

    await runAction(`voice-${action}`, async () => {
      const result = await api('/discord-tools/voice', {
        method: 'POST',
        body: {
          ...botConfig,
          action: isLeaving ? 'leave' : action === 'Move voice' ? 'move' : 'join',
          voiceChannelId: control.voiceChannelId,
          voiceDuration: control.voiceDuration,
          voiceHours: control.voiceHours,
          voiceMinutes: control.voiceMinutes,
          voiceAfkMode: control.voiceAfkMode
        }
      });
      const startedAt = isLeaving ? '' : new Date().toISOString();
      const voiceConnected = !isLeaving;
      updateControl({
        voiceConnected,
        voiceStartedAt: startedAt,
        voiceStayUntilStopped: control.voiceDuration === 'forever'
      });
      updateManagedBot(control.selectedBotId, {
        voiceChannelId: control.voiceChannelId,
        voiceDuration: control.voiceDuration,
        voiceConnected,
        voiceStartedAt: startedAt,
        voiceVolume: control.voiceVolume,
        voiceAfkMode: control.voiceAfkMode,
        voiceAutoReconnect: control.voiceAutoReconnect
      });
      setBotStatus((current) => current ? { ...current, runtime: result.runtime } : current);
      pushLog('voice', `${action}: ${channel?.name || 'canal nao selecionado'}`, selectedManagedBot.name);
      showNotice(control.voiceDuration === 'forever' && !isLeaving
        ? 'Bot entrou na call e fica ate voce desligar.'
        : isLeaving ? 'Bot saiu da call.' : 'Bot entrou na call.');
    });
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

  function validateWebhookContent() {
    if (!webhook.content.trim() && !hasDiscordEmbedContent(embed)) {
      showNotice('Escreva uma mensagem ou preencha algum campo do embed.');
      return false;
    }
    return true;
  }

  async function postWebhookMessage() {
    return api('/discord-tools/webhook/send', {
      method: 'POST',
      body: { ...webhook, embed }
    });
  }

  async function waitForRepeatDelay(ms) {
    const step = 250;
    let elapsed = 0;
    while (elapsed < ms) {
      if (repeatStopRef.current) return false;
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(step, ms - elapsed)));
      elapsed += step;
    }
    return !repeatStopRef.current;
  }

  async function sendWebhookMessage() {
    if (!validateWebhookContent()) return;

    await runAction('webhook', async () => {
      const result = await postWebhookMessage();
      pushLog('webhook', `Mensagem enviada pelo webhook ${result.messageId || ''}`);
      showNotice('Mensagem enviada no Discord.');
    });
  }

  async function sendRepeatedWebhookMessages() {
    if (!validateWebhookContent()) return;
    if (loading === 'webhook-repeat') return;

    const requestedCount = Number(repeatOptions.count);
    const requestedDelay = Number(repeatOptions.delaySeconds);
    const total = Math.min(100, Number.isFinite(requestedCount) ? Math.max(1, Math.floor(requestedCount)) : 1);
    const delaySeconds = Math.min(300, Number.isFinite(requestedDelay) ? Math.max(1, requestedDelay) : 1);
    repeatStopRef.current = false;
    setLoading('webhook-repeat');
    setNotice('');
    setRepeatStatus({ active: true, sent: 0, total });

    try {
      let sent = 0;
      for (let index = 1; index <= total; index += 1) {
        if (repeatStopRef.current) break;
        const result = await postWebhookMessage();
        sent = index;
        setRepeatStatus({ active: true, sent, total });
        pushLog('webhook', `Mensagem repetida ${sent}/${total} ${result.messageId || ''}`);
        if (index < total) {
          const shouldContinue = await waitForRepeatDelay(delaySeconds * 1000);
          if (!shouldContinue) break;
        }
      }
      showNotice(repeatStopRef.current ? `Envio repetido parado em ${sent}/${total}.` : `Envio repetido concluido (${total}).`);
    } catch (error) {
      showNotice(error.message);
    } finally {
      repeatStopRef.current = false;
      setLoading('');
      setRepeatStatus((current) => ({ ...current, active: false }));
    }
  }

  function stopRepeatedWebhookMessages() {
    if (loading !== 'webhook-repeat') return;
    repeatStopRef.current = true;
    showNotice('Parando envio repetido...');
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
      updateManagedBot(control.selectedBotId, {
        name: payload.bot?.username || selectedManagedBot.name,
        applicationId: payload.application?.id || payload.bot?.id || selectedManagedBot.applicationId || '',
        avatarUrl: payload.bot?.avatarUrl || selectedManagedBot.avatarUrl,
        guildId: botConfig.guildId || payload.guild?.id || selectedManagedBot.guildId,
        guildName: payload.guild?.name || selectedManagedBot.guildName,
        guildCount: payload.bot?.guildCount || 0,
        memberCount: payload.guild?.memberCount || 0,
        onlineCount: payload.guild?.onlineCount || 0,
        channelCount: payload.guild?.channelCount || 0,
        roleCount: payload.guild?.roleCount || 0,
        ping: payload.bot?.ping || 0,
        desiredStatus: payload.bot?.online ? control.desiredStatus : 'offline'
      });
      pushLog('bot', `Status carregado para ${payload.guild?.name || 'bot'}`);
      showNotice(payload.warnings?.length ? payload.warnings[0] : 'Bot conectado.');
    });
  }

  async function saveBotProfile() {
    if (!botConfig.guildId && control.profileDisplayName) return showNotice('Informe o ID do servidor para trocar o nome do bot no servidor.');
    await runAction('profile', async () => {
      const result = await api('/discord-tools/bot/profile', {
        method: 'POST',
        body: {
          ...botConfig,
          status: control.desiredStatus,
          activityType: control.profileActivityType,
          activityMessage: control.profileActivityMessage || control.profileStatusText || 'Nexus dashboard',
          displayName: control.profileDisplayName,
          avatarUrl: control.profileAvatarUrl
        }
      });
      updateManagedBot(control.selectedBotId, {
        name: control.profileDisplayName || selectedManagedBot.name,
        avatarUrl: control.profileAvatarUrl || selectedManagedBot.avatarUrl,
        desiredStatus: control.desiredStatus
      });
      setBotStatus((current) => current ? {
        ...current,
        runtime: result.runtime,
        bot: {
          ...current.bot,
          online: Boolean(result.runtime?.online),
          username: control.profileDisplayName || current.bot?.username,
          avatarUrl: control.profileAvatarUrl || current.bot?.avatarUrl
        }
      } : current);
      pushLog('bot', `Perfil/status aplicado: ${control.desiredStatus}`, selectedManagedBot.name);
      showNotice(result.avatarUpdated ? 'Perfil, status e avatar aplicados.' : 'Perfil e status aplicados no Discord.');
    });
  }

  async function applyCounterNow(silent = false) {
    if (!botConfig.guildId) {
      if (!silent) showNotice('Informe ou carregue o servidor antes do contador.');
      return;
    }
    if (control.counterTargetType !== 'bot-nickname' && !control.counterTargetId) {
      if (!silent) showNotice('Informe o ID do canal ou categoria do contador.');
      return;
    }
    await runAction(silent ? 'counter-auto' : 'counter', async () => {
      const result = await api('/discord-tools/counters/apply', {
        method: 'POST',
        body: {
          ...botConfig,
          targetType: control.counterTargetType,
          targetId: control.counterTargetId,
          template: control.counterTemplate
        }
      });
      if (control.counterTargetType === 'bot-nickname') {
        updateManagedBot(control.selectedBotId, { name: result.name, memberCount: result.stats?.members || selectedManagedBot.memberCount || 0 });
      }
      pushLog('bot', `Contador atualizado: ${result.name}`, selectedManagedBot.name);
      if (!silent) showNotice(`Contador atualizado: ${result.name}`);
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

  function getInviteClientId(bot = selectedManagedBot) {
    if (bot.id === selectedManagedBot.id && control.inviteClientId.trim()) return control.inviteClientId.trim();
    if (bot.id === selectedManagedBot.id && botStatus?.application?.id) return botStatus.application.id;
    if (bot.id === selectedManagedBot.id && botStatus?.bot?.id) return botStatus.bot.id;
    return extractApplicationIdFromBotCard(bot);
  }

  function buildInviteUrl(bot = selectedManagedBot) {
    const clientId = getInviteClientId(bot);
    if (!clientId) return '';
    const scopes = ['bot'];
    if (control.inviteIncludeCommands) scopes.push('applications.commands');
    const params = new URLSearchParams({
      client_id: clientId,
      permissions: String(control.invitePermissions || '8'),
      scope: scopes.join(' ')
    });
    const guildId = (bot.id === selectedManagedBot.id ? control.inviteGuildId : '') || botConfig.guildId || bot.guildId || '';
    if (guildId) params.set('guild_id', guildId);
    if (control.inviteDisableGuildSelect && guildId) params.set('disable_guild_select', 'true');
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  function copyInviteLink(bot = selectedManagedBot) {
    const inviteUrl = buildInviteUrl(bot);
    if (!inviteUrl) return showNotice('Carregue o bot ou informe o Client/Application ID.');
    copyText(inviteUrl);
    pushLog('bot', `Convite copiado para ${bot.name || 'bot'}`);
    showNotice('Link de convite copiado.');
  }

  function openInviteLink(bot = selectedManagedBot) {
    const inviteUrl = buildInviteUrl(bot);
    if (!inviteUrl) return showNotice('Carregue o bot ou informe o Client/Application ID.');
    window.open(inviteUrl, '_blank', 'noopener,noreferrer');
  }

  function clearWebhook() {
    setWebhook({ webhookUrl: '', content: '', username: '', avatarUrl: '' });
    setEmbed(defaultDiscordEmbed);
    showNotice('Campos limpos.');
  }

  async function saveAntiNuke() {
    if (!botConfig.guildId) return showNotice('Informe ou carregue o servidor antes de ativar a protecao.');
    await runAction('anti-nuke-save', async () => {
      const payload = await api('/discord-tools/protection/configure', {
        method: 'POST',
        body: { ...botConfig, ...antiNuke }
      });
      const savedProtection = payload.protection || antiNuke;
      setAntiNuke(savedProtection);
      updateSettings({ ...settings, antiNuke: savedProtection, logChannelId: savedProtection.logChannelId });
      api(`/discord-tools/protection/stats?guildId=${encodeURIComponent(botConfig.guildId)}&limit=30`).then(setProtectionStats).catch(() => {});
      pushLog('anti-nuke', `Protecao ${antiNuke.enabled ? 'ativa' : 'desativada'} no Gateway`, selectedManagedBot.name);
      const warnings = payload.diagnostics?.warnings || [];
      showNotice(warnings.length
        ? `Protecao salva com ${warnings.length} aviso(s): ${warnings[0]}`
        : (antiNuke.enabled ? 'Anti-nuke ativado e permissoes verificadas.' : 'Anti-nuke desativado no bot.'));
    });
  }

  function saveBotSettings() {
    updateSettings(settings);
    pushLog('settings', 'Configuracoes do bot salvas');
    showNotice('Configuracoes salvas.');
  }

  function renderControlOverview() {
    const selectedBot = botCards.find((bot) => bot.id === control.selectedBotId) || botCards[0];
    const selectedGuild = botStatus?.guild;
    const permissionChecks = [
      { label: 'Token do bot', ok: Boolean(botStatus?.bot), detail: botStatus?.bot ? 'Validado' : 'Carregue o bot' },
      { label: 'Servidor selecionado', ok: Boolean(selectedGuild || selectedManagedBot.guildId), detail: selectedGuild?.name || selectedManagedBot.guildId || 'Sem Guild ID' },
      { label: 'Canais acessiveis', ok: Boolean(botStatus?.channels?.length), detail: `${botStatus?.channels?.length || 0} canais` },
      { label: 'Cargos acessiveis', ok: Boolean(botStatus?.roles?.length), detail: `${botStatus?.roles?.length || 0} cargos` }
    ];

    return (
      <div className="discord-control-stack">
        <section className="panel discord-control-hero">
          <div>
            <p className="eyebrow">Control center</p>
            <h3>{selectedBot?.name || 'Discord Bot'}</h3>
            <p className="muted">Painel multi-bot com servidores, membros, voz, comandos, webhooks, logs e seguranca.</p>
          </div>
          <div className="discord-control-topbar">
            <label>
              Bot
              <select value={control.selectedBotId} onChange={(event) => selectManagedBot(event.target.value)}>
                {botCards.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
            </label>
            <label>
              Servidor
              <select value={botConfig.guildId} onChange={(event) => updateBot('guildId', event.target.value)}>
                <option value={botConfig.guildId}>{selectedGuild?.name || botConfig.guildId || 'Carregue o bot'}</option>
                {(botStatus?.guilds || []).map((guild) => (
                  <option key={guild.id} value={guild.id}>{guild.name}</option>
                ))}
              </select>
            </label>
            <label>
              Buscar
              <input value={control.search || ''} onChange={(event) => updateControl({ search: event.target.value })} placeholder="Comandos, logs, usuarios" />
            </label>
          </div>
        </section>

        <div className="discord-control-grid">
          <section className="panel discord-tool-card">
            <div className="panel-title">
              <h3>Bots</h3>
              <button className="ghost-button" type="button" onClick={openAddBotModal}><Plus size={16} /> Bot</button>
            </div>
            <div className="discord-bot-card-grid">
              {botCards.map((bot) => (
                <article className={`discord-bot-card ${bot.id === control.selectedBotId ? 'active' : ''}`} key={bot.id}>
                  <Avatar src={bot.avatarUrl} name={bot.name} size="lg" />
                  <span>
                    <strong>{bot.name}</strong>
                    <small>{bot.guildCount || 0} servidor(es) - {bot.memberCount || 0} membros - {bot.ping || 0}ms</small>
                    <small>{bot.voiceConnected ? 'Call ativa no painel' : bot.guildName || bot.guildId || 'Sem servidor carregado'}</small>
                  </span>
                  <i className={`discord-status-dot ${bot.status}`} />
                  <div className="card-actions compact-actions">
                    {bot.id === control.selectedBotId ? (
                      <>
                        <button className="ghost-button" onClick={() => runBotLifecycle('start')}><ToggleRight size={16} /> Start</button>
                        <button className="ghost-button" onClick={() => runBotLifecycle('restart')}><RefreshCw size={16} /> Restart</button>
                      </>
                    ) : (
                      <button className="ghost-button" onClick={() => selectManagedBot(bot.id)}><Check size={16} /> Usar</button>
                    )}
                    <button className="ghost-button" onClick={() => removeManagedBot(bot.id)} disabled={managedBots.length <= 1}><Trash2 size={16} /> Remover</button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel discord-tool-card">
            <div className="panel-title">
              <h3>Servidor ativo</h3>
              <Server size={18} />
            </div>
            {selectedGuild ? (
              <>
                <div className="discord-server-card">
                  <Avatar src={selectedGuild.iconUrl} name={selectedGuild.name} />
                  <span>
                    <strong>{selectedGuild.name}</strong>
                    <small>ID {selectedGuild.id}</small>
                  </span>
                </div>
                <div className="discord-stat-grid">
                  <Metric icon={Users} label="Membros" value={selectedGuild.memberCount || 0} />
                  <Metric icon={Activity} label="Online" value={selectedGuild.onlineCount || 0} />
                  <Metric icon={Hash} label="Canais" value={selectedGuild.channelCount || 0} />
                  <Metric icon={Crown} label="Cargos" value={selectedGuild.roleCount || 0} />
                  <Metric icon={Bot} label="Bots" value={managedBots.length} />
                </div>
              </>
            ) : (
              <EmptyState icon={Server} title="Carregue o bot para ver servidores" />
            )}
          </section>
        </div>

        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Permission checker</h3>
            <ShieldCheck size={18} />
          </div>
          <div className="discord-check-grid">
            {permissionChecks.map((item) => (
              <article className={item.ok ? 'ok' : 'warn'} key={item.label}>
                {item.ok ? <Check size={18} /> : <AlertTriangle size={18} />}
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </article>
            ))}
          </div>
        </section>
      </div>
    );
  }

  function renderRuntimeControl() {
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Online / Offline</h3>
            <Activity size={18} />
          </div>
          <div className="discord-status-console">
            <span>
              <i className={`discord-status-dot ${control.desiredStatus}`} />
              <strong>{control.desiredStatus}</strong>
              <small>{control.maintenanceMode ? 'Maintenance mode ativo' : 'Comandos liberados'}</small>
            </span>
            <div className="discord-action-grid">
              <button className="primary-button" onClick={() => runBotLifecycle('start')}><ToggleRight size={17} /> Start Bot</button>
              <button className="ghost-button" onClick={() => runBotLifecycle('stop')}><ToggleLeft size={17} /> Stop Bot</button>
              <button className="ghost-button" onClick={() => runBotLifecycle('restart')}><RefreshCw size={17} /> Restart Bot</button>
              <button className="ghost-button" onClick={() => runBotLifecycle('reconnect')}><Shuffle size={17} /> Reconnect</button>
            </div>
          </div>
          <div className="discord-form-grid">
            <label>
              Status desejado
              <select value={control.desiredStatus} onChange={(event) => updateControl({ desiredStatus: event.target.value })}>
                {discordStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label>
              Ao terminar timer
              <select value={control.timerEndAction} onChange={(event) => updateControl({ timerEndAction: event.target.value })}>
                <option value="offline">Offline</option>
                <option value="idle">Idle</option>
                <option value="dnd">Do Not Disturb</option>
              </select>
            </label>
          </div>
          <div className="discord-toggle-grid">
            <label className="switch-line"><input type="checkbox" checked={control.autoReconnect} onChange={(event) => updateControl({ autoReconnect: event.target.checked })} /> Auto reconnect</label>
            <label className="switch-line"><input type="checkbox" checked={control.maintenanceMode} onChange={(event) => updateControl({ maintenanceMode: event.target.checked })} /> Maintenance mode</label>
            <label className="switch-line"><input type="checkbox" checked={control.statusRotation} onChange={(event) => updateControl({ statusRotation: event.target.checked })} /> Status rotation</label>
          </div>
        </section>

        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Agenda</h3>
            <Clock3 size={18} />
          </div>
          <div className="discord-preset-grid">
            {discordSchedulePresets.map((preset) => (
              <button key={preset.id} className={control.schedulePreset === preset.id ? 'active' : ''} onClick={() => updateControl({ schedulePreset: preset.id })}>{preset.label}</button>
            ))}
          </div>
          <div className="discord-form-grid">
            <label>Horas<input type="number" min="0" value={control.customHours} onChange={(event) => updateControl({ customHours: Number(event.target.value) })} /></label>
            <label>Minutos<input type="number" min="0" max="59" value={control.customMinutes} onChange={(event) => updateControl({ customMinutes: Number(event.target.value) })} /></label>
            <label>Segundos<input type="number" min="0" max="59" value={control.customSeconds} onChange={(event) => updateControl({ customSeconds: Number(event.target.value) })} /></label>
          </div>
          <button className="primary-button" onClick={() => { pushLog('bot', `Agenda salva: ${control.schedulePreset}`); showNotice('Agenda operacional salva.'); }}><Save size={17} /> Salvar agenda</button>
        </section>
      </div>
    );
  }

  function renderVoiceControl() {
    const activeVoice = voiceChannels.find((channel) => channel.id === control.voiceChannelId);
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Voice control</h3>
            <Volume2 size={18} />
          </div>
          <div className="discord-form-grid">
            <label className="wide">
              Canal de voz
              <select value={control.voiceChannelId} onChange={(event) => updateControl({ voiceChannelId: event.target.value })}>
                <option value="">Selecione um canal</option>
                {voiceChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
              </select>
            </label>
            <label>
              Duracao
              <select value={control.voiceDuration} onChange={(event) => updateControl({ voiceDuration: event.target.value })}>
                <option value="30m">30 minutos</option>
                <option value="1h">1 hora</option>
                <option value="6h">6 horas</option>
                <option value="forever">Ate desligar</option>
                <option value="custom">Personalizado</option>
              </select>
            </label>
            <label>Volume<input type="range" min="0" max="100" value={control.voiceVolume} onChange={(event) => updateControl({ voiceVolume: Number(event.target.value) })} /></label>
            {control.voiceDuration === 'custom' && (
              <>
                <label>Horas em call<input type="number" min="0" value={control.voiceHours} onChange={(event) => updateControl({ voiceHours: Number(event.target.value) })} /></label>
                <label>Minutos em call<input type="number" min="0" max="59" value={control.voiceMinutes} onChange={(event) => updateControl({ voiceMinutes: Number(event.target.value) })} /></label>
              </>
            )}
          </div>
          <div className="discord-toggle-grid">
            <label className="switch-line"><input type="checkbox" checked={control.voiceDuration === 'forever'} onChange={(event) => updateControl({ voiceDuration: event.target.checked ? 'forever' : '1h', voiceStayUntilStopped: event.target.checked })} /> Ficar em call ate eu desligar</label>
            <label className="switch-line"><input type="checkbox" checked={control.voiceAfkMode} onChange={(event) => updateControl({ voiceAfkMode: event.target.checked })} /> AFK voice mode</label>
            <label className="switch-line"><input type="checkbox" checked={control.voiceAutoReconnect} onChange={(event) => updateControl({ voiceAutoReconnect: event.target.checked })} /> Auto reconnect voice</label>
          </div>
          <div className="card-actions">
            <button className="primary-button" onClick={() => saveVoicePlan('Join voice')}><Volume2 size={17} /> Join voice</button>
            <button className="ghost-button" onClick={() => saveVoicePlan('Move voice')}><Shuffle size={17} /> Move</button>
            <button className="ghost-button" onClick={() => saveVoicePlan('Leave voice')}><X size={17} /> Leave</button>
          </div>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Estado da call</h3>
            <Activity size={18} />
          </div>
          <div className="discord-status-hero">
            <Volume2 size={28} />
            <span>
              <strong>{control.voiceConnected ? activeVoice?.name || 'Call marcada como ativa' : 'Nenhum canal conectado'}</strong>
              <small>{control.voiceDuration === 'forever' ? 'Fica ate voce desligar' : `Duracao: ${control.voiceDuration}`} - volume {control.voiceVolume}%</small>
              {control.voiceStartedAt && <small>Inicio salvo: {formatDate(control.voiceStartedAt)}</small>}
            </span>
          </div>
          <div className="discord-check-grid mini">
            <article className={control.voiceConnected ? 'ok' : 'warn'}>{control.voiceConnected ? <Check size={18} /> : <AlertTriangle size={18} />}<span><strong>{control.voiceConnected ? 'Ativo no painel' : 'Desligado no painel'}</strong><small>{selectedManagedBot.name}</small></span></article>
            <article className={control.voiceDuration === 'forever' ? 'ok' : 'warn'}><Clock3 size={18} /><span><strong>{control.voiceDuration === 'forever' ? 'Sem timer' : 'Com timer'}</strong><small>{control.voiceDuration === 'custom' ? `${control.voiceHours}h ${control.voiceMinutes}m` : control.voiceDuration}</small></span></article>
          </div>
        </section>
      </div>
    );
  }

  function renderProfileControl() {
    const previewName = control.profileDisplayName || botStatus?.bot?.username || selectedManagedBot.name || 'Nexus Bot';
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title"><h3>Bot profile</h3><Palette size={18} /></div>
          <div className="discord-form-grid">
            <label>Nome no servidor<input value={control.profileDisplayName} onChange={(event) => updateControl({ profileDisplayName: event.target.value })} placeholder={botStatus?.bot?.username || 'Nexus Bot'} /></label>
            <label>Status<input value={control.profileStatusText} onChange={(event) => updateControl({ profileStatusText: event.target.value })} placeholder="Online agora" /></label>
            <label>Activity type<select value={control.profileActivityType} onChange={(event) => updateControl({ profileActivityType: event.target.value })}><option>Watching</option><option>Playing</option><option>Listening</option><option>Competing</option></select></label>
            <label>Activity message<input value={control.profileActivityMessage} onChange={(event) => updateControl({ profileActivityMessage: event.target.value })} /></label>
            <label className="wide">Avatar URL<input value={control.profileAvatarUrl} onChange={(event) => updateControl({ profileAvatarUrl: event.target.value })} placeholder="https://..." /></label>
            <label className="wide">Banner URL<input value={control.profileBannerUrl} onChange={(event) => updateControl({ profileBannerUrl: event.target.value })} placeholder="https://..." /></label>
          </div>
          <div className="card-actions">
            <button className="primary-button" onClick={saveBotProfile} disabled={loading === 'profile'}><Save size={17} /> {loading === 'profile' ? 'Aplicando' : 'Aplicar no Discord'}</button>
            <button className="ghost-button" onClick={() => updateControl({ profileDisplayName: '', profileStatusText: '', profileAvatarUrl: '', profileBannerUrl: '' })}><RefreshCw size={17} /> Reset</button>
          </div>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title"><h3>Preview</h3><Eye size={18} /></div>
          <div className="discord-profile-preview">
            <div className="discord-profile-banner" style={control.profileBannerUrl ? { backgroundImage: `url(${control.profileBannerUrl})` } : undefined} />
            <Avatar src={control.profileAvatarUrl || botStatus?.bot?.avatarUrl || selectedManagedBot.avatarUrl} name={previewName} size="xl" />
            <span><strong>{previewName}</strong><small>{control.profileActivityType} {control.profileActivityMessage}</small><small>{control.profileStatusText || control.desiredStatus}</small></span>
          </div>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title"><h3>Contadores</h3><Users size={18} /></div>
          <div className="discord-form-grid">
            <label>
              Onde atualizar
              <select value={control.counterTargetType} onChange={(event) => updateControl({ counterTargetType: event.target.value })}>
                <option value="bot-nickname">Nome do bot no servidor</option>
                <option value="channel">Nome de canal</option>
                <option value="category">Nome de categoria</option>
              </select>
            </label>
            <label>
              Canal/Categoria ID
              <input value={control.counterTargetId} onChange={(event) => updateControl({ counterTargetId: event.target.value })} placeholder="Vazio para nome do bot" disabled={control.counterTargetType === 'bot-nickname'} />
            </label>
            <label className="wide">
              Modelo
              <input value={control.counterTemplate} onChange={(event) => updateControl({ counterTemplate: event.target.value })} placeholder="Membros: {members}" />
            </label>
            <label>
              Intervalo
              <input type="number" min="1" max="60" value={control.counterIntervalMinutes} onChange={(event) => updateControl({ counterIntervalMinutes: Number(event.target.value) })} />
            </label>
          </div>
          <div className="notice subtle">Variaveis: {'{members}'}, {'{online}'}, {'{channels}'}, {'{roles}'}, {'{server}'}.</div>
          <div className="discord-toggle-grid">
            <label className="switch-line"><input type="checkbox" checked={control.counterAuto} onChange={(event) => updateControl({ counterAuto: event.target.checked })} /> Atualizar automaticamente enquanto painel estiver aberto</label>
          </div>
          <div className="card-actions">
            <button className="primary-button" onClick={() => applyCounterNow(false)} disabled={loading === 'counter'}><RefreshCw size={17} /> Atualizar agora</button>
          </div>
        </section>
      </div>
    );
  }

  function renderInviteManager() {
    const inviteUrl = buildInviteUrl();
    const selectedClientId = getInviteClientId();
    const selectedPreset = discordInvitePresets.find((preset) => preset.permissions === String(control.invitePermissions))?.id || 'custom';
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title"><h3>Criar convite do bot</h3><Share2 size={18} /></div>
          <div className="discord-form-grid">
            <label>
              Bot
              <select value={control.selectedBotId} onChange={(event) => selectManagedBot(event.target.value)}>
                {managedBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
            </label>
            <label>
              Client/Application ID
              <input value={control.inviteClientId} onChange={(event) => updateControl({ inviteClientId: event.target.value })} placeholder={selectedClientId || 'Carregue o bot ou cole o ID'} />
            </label>
            <label>
              Permissoes
              <select
                value={selectedPreset}
                onChange={(event) => {
                  const preset = discordInvitePresets.find((item) => item.id === event.target.value);
                  if (preset) updateControl({ invitePermissions: preset.permissions });
                }}
              >
                {discordInvitePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                <option value="custom">Personalizado</option>
              </select>
            </label>
            <label>
              Valor das permissoes
              <input value={control.invitePermissions} onChange={(event) => updateControl({ invitePermissions: event.target.value.replace(/[^\d]/g, '') })} placeholder="8" />
            </label>
            <label>
              Servidor alvo
              <input value={control.inviteGuildId} onChange={(event) => updateControl({ inviteGuildId: event.target.value })} placeholder={botConfig.guildId || selectedManagedBot.guildId || 'Opcional'} />
            </label>
            <label className="wide">
              Link gerado
              <input readOnly value={inviteUrl || 'Carregue o bot ou informe o Client/Application ID'} />
            </label>
          </div>
          <div className="discord-toggle-grid">
            <label className="switch-line"><input type="checkbox" checked={control.inviteIncludeCommands} onChange={(event) => updateControl({ inviteIncludeCommands: event.target.checked })} /> Incluir slash commands</label>
            <label className="switch-line"><input type="checkbox" checked={control.inviteDisableGuildSelect} onChange={(event) => updateControl({ inviteDisableGuildSelect: event.target.checked })} /> Fixar nesse servidor</label>
          </div>
          <div className="card-actions">
            <button className="primary-button" type="button" onClick={() => copyInviteLink()}><Copy size={17} /> Copiar convite</button>
            <button className="ghost-button" type="button" onClick={() => openInviteLink()}><Share2 size={17} /> Abrir convite</button>
            <button className="ghost-button" type="button" onClick={loadBotStatus}><RefreshCw size={17} /> Pegar ID pelo token</button>
          </div>
          <div className="notice subtle">Para o link funcionar, use o Application ID do bot. Quando voce adiciona ou carrega o bot pelo token, o painel pega esse ID automatico.</div>
        </section>

        <section className="panel discord-tool-card">
          <div className="panel-title"><h3>Convites por bot</h3><Bot size={18} /></div>
          <div className="discord-list compact-list">
            {botCards.map((bot) => {
              const clientId = getInviteClientId(bot);
              return (
                <article className="discord-list-item" key={bot.id}>
                  <button type="button" onClick={() => selectManagedBot(bot.id)}>
                    <Avatar src={bot.avatarUrl} name={bot.name} />
                    <span>
                      <strong>{bot.name}</strong>
                      <small>{clientId ? `Client ID ${clientId}` : 'Carregue esse bot para gerar convite'}</small>
                    </span>
                  </button>
                  <div className="footer-actions">
                    <IconButton label="Copiar convite" onClick={() => copyInviteLink(bot)} disabled={!clientId}>
                      <Copy size={15} />
                    </IconButton>
                    <IconButton label="Abrir convite" onClick={() => openInviteLink(bot)} disabled={!clientId}>
                      <Share2 size={15} />
                    </IconButton>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  function renderCommandCenter() {
    return (
      <div className="discord-control-stack">
        <section className="panel discord-tool-card">
          <div className="panel-title"><h3>Command Center</h3><SlidersHorizontal size={18} /></div>
          <div className="discord-form-grid">
            <label>Cooldown global<input type="number" min="0" value={control.commandCooldown} onChange={(event) => updateControl({ commandCooldown: Number(event.target.value) })} /></label>
            <label>Role permitida<input value={control.commandRole} onChange={(event) => updateControl({ commandRole: event.target.value })} placeholder="Role ID opcional" /></label>
            <label className="wide">Canal permitido<input value={control.commandChannel} onChange={(event) => updateControl({ commandChannel: event.target.value })} placeholder="Channel ID opcional" /></label>
          </div>
        </section>
        <div className="discord-command-grid">
          {discordCommandCatalog.map((command) => {
            const current = { enabled: command.enabled, ...(control.commandConfig?.[command.id] || {}) };
            return (
              <article className="panel discord-tool-card discord-command-card" key={command.id}>
                <strong>/{command.id}</strong>
                <small>{command.label} - {command.category}</small>
                <label className="switch-line"><input type="checkbox" checked={current.enabled} onChange={(event) => updateCommandConfig(command.id, { enabled: event.target.checked })} /> Ativo</label>
                <label>Cooldown<input type="number" min="0" value={current.cooldown ?? control.commandCooldown} onChange={(event) => updateCommandConfig(command.id, { cooldown: Number(event.target.value) })} /></label>
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  function renderSecurityCenter() {
    const checks = [
      { label: 'Protecao ativa', ok: antiNuke.enabled, detail: antiNuke.enabled ? 'Monitoramento ligado' : 'Desativada' },
      { label: 'Logs locais', ok: settings.modules?.logs !== false, detail: `${logs.length} eventos` },
      { label: 'Token protegido', ok: true, detail: 'Token temporario nao fica salvo no navegador' },
      { label: 'Backup config', ok: true, detail: 'Exportacao pronta' }
    ];
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title"><h3>Seguranca</h3><ShieldCheck size={18} /></div>
          <div className="discord-check-grid">
            {checks.map((item) => (
              <article className={item.ok ? 'ok' : 'warn'} key={item.label}>{item.ok ? <Check size={18} /> : <AlertTriangle size={18} />}<span><strong>{item.label}</strong><small>{item.detail}</small></span></article>
            ))}
          </div>
          <div className="card-actions">
            <button className="ghost-button" onClick={() => { copyText(JSON.stringify({ settings, antiNuke, control, managedBots }, null, 2)); showNotice('Configuracao copiada.'); }}><Copy size={17} /> Exportar config</button>
            <button className="primary-button" onClick={saveAntiNuke}><Save size={17} /> Salvar protecao</button>
          </div>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title"><h3>Ultimos eventos</h3><ScrollText size={18} /></div>
          <div className="discord-list">
            {visibleLogs.slice(0, 8).map((log) => (
              <article className="discord-log-row" key={log.id}><span className={`discord-log-dot ${log.type}`} /><span><strong>{log.detail}</strong><small>{formatDate(log.createdAt)}</small></span></article>
            ))}
            {visibleLogs.length === 0 && <EmptyState icon={ScrollText} title="Nenhum log recente" />}
          </div>
        </section>
      </div>
    );
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
          <div className="discord-repeat-panel">
            <div className="panel-title compact">
              <div>
                <h3>Mensagens repetidas</h3>
                <small>Envio rapido com limite de 100 mensagens por rodada.</small>
              </div>
              <Clock3 size={18} />
            </div>
            <div className="discord-form-grid">
              <label>
                Quantas vezes
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={repeatOptions.count}
                  onChange={(event) => updateRepeatOption('count', event.target.value)}
                  disabled={loading === 'webhook-repeat'}
                />
              </label>
              <label>
                Delay entre mensagens
                <input
                  type="number"
                  min="1"
                  max="300"
                  value={repeatOptions.delaySeconds}
                  onChange={(event) => updateRepeatOption('delaySeconds', event.target.value)}
                  disabled={loading === 'webhook-repeat'}
                />
              </label>
            </div>
            <div className="discord-repeat-status">
              <span>
                <strong>{repeatStatus.active ? 'Enviando repetidas' : 'Pronto para repetir'}</strong>
                <small>{repeatStatus.total ? `${repeatStatus.sent}/${repeatStatus.total} enviadas` : 'Limite de 100 por rodada, delay minimo de 1s'}</small>
              </span>
              <div className="discord-repeat-progress">
                <span style={{ width: repeatStatus.total ? `${Math.min(100, (repeatStatus.sent / repeatStatus.total) * 100)}%` : '0%' }} />
              </div>
            </div>
            <div className="card-actions">
              <button className="ghost-button" onClick={sendRepeatedWebhookMessages} disabled={loading === 'webhook-repeat'}>
                <RefreshCw size={17} />
                {loading === 'webhook-repeat' ? 'Enviando...' : 'Enviar repetidas'}
              </button>
              <button className="danger-button" onClick={stopRepeatedWebhookMessages} disabled={loading !== 'webhook-repeat'}>
                <X size={17} />
                Parar
              </button>
            </div>
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
            <h3>Multi bot</h3>
            <button className="ghost-button" type="button" onClick={openAddBotModal}>
              <Plus size={16} />
              Adicionar
            </button>
          </div>
          <div className="notice subtle">Cole o token para validar e adicionar outro bot. O token fica so nesta sessao.</div>
          <div className="discord-form-grid">
            <label>
              Token do novo bot
              <input type="password" value={newBotForm.token} onChange={(event) => setNewBotForm((current) => ({ ...current, token: event.target.value }))} placeholder="Bot token" />
            </label>
            <label>
              ID do servidor
              <input value={newBotForm.guildId} onChange={(event) => setNewBotForm((current) => ({ ...current, guildId: event.target.value }))} placeholder="Opcional" />
            </label>
            <label className="wide">
              Nome no painel
              <input value={newBotForm.name} onChange={(event) => setNewBotForm((current) => ({ ...current, name: event.target.value }))} placeholder="Opcional, usa o nome real do bot" />
            </label>
          </div>
          <div className="card-actions">
            <button className="primary-button" onClick={addManagedBot} disabled={loading === 'bot-add'}>
              <Plus size={17} />
              {loading === 'bot-add' ? 'Validando' : 'Adicionar bot pelo token'}
            </button>
          </div>
          <div className="notice subtle">{selectedManagedBot.name}: salvo no navegador fica so nome, servidor e preferencias do painel.</div>
          <div className="discord-form-grid">
            <label>
              Nome no painel
              <input value={selectedManagedBot.name} onChange={(event) => updateManagedBot(control.selectedBotId, { name: event.target.value })} placeholder="Meu bot" />
            </label>
            <label>
              Cor
              <input type="color" value={selectedManagedBot.color || '#5865f2'} onChange={(event) => updateManagedBot(control.selectedBotId, { color: event.target.value })} />
            </label>
            <label>
              Token do bot temporario
              <input type="password" value={botConfig.botToken} onChange={(event) => updateBot('botToken', event.target.value)} placeholder="Opcional se DISCORD_BOT_TOKEN estiver no backend" />
            </label>
            <label>
              ID do servidor
              <input value={botConfig.guildId} onChange={(event) => updateBot('guildId', event.target.value)} placeholder="Guild ID" />
            </label>
          </div>
          <div className="card-actions">
            <button className="primary-button" onClick={loadBotStatus} disabled={loading === 'bot'}>
              <RefreshCw size={17} />
              {loading === 'bot' ? 'Conectando' : 'Carregar servidor'}
            </button>
            <button className="ghost-button" onClick={() => runBotLifecycle('restart')}><RefreshCw size={17} /> Restart painel</button>
          </div>
          <div className="discord-list compact-list">
            {botCards.map((bot) => (
              <article className="discord-list-item" key={bot.id}>
                <button onClick={() => selectManagedBot(bot.id)}>
                  <Avatar src={bot.avatarUrl} name={bot.name} />
                  <span>
                    <strong>{bot.name}</strong>
                    <small>{bot.guildName || bot.guildId || 'Sem servidor'} - {bot.status}</small>
                  </span>
                </button>
                <IconButton label="Remover bot" onClick={() => removeManagedBot(bot.id)} disabled={managedBots.length <= 1}>
                  <Trash2 size={15} />
                </IconButton>
              </article>
            ))}
          </div>
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
                <Metric icon={Activity} label="Online" value={botStatus.guild?.onlineCount || 0} />
                <Metric icon={Hash} label="Canais" value={botStatus.guild?.channelCount || 0} />
                <Metric icon={Crown} label="Cargos" value={botStatus.guild?.roleCount || 0} />
                <Metric icon={Server} label="Servidores" value={botStatus.bot.guildCount || 0} />
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
    const detectorGroups = Object.entries(protectionCatalog.categories || {}).map(([categoryId, label]) => ({
      id: categoryId,
      label,
      detectors: (protectionCatalog.detectors || []).filter((detector) => detector.category === categoryId)
    }));
    const activeDetectors = Object.values(antiNuke.detectors || {}).filter((detector) => detector?.enabled).length;
    const updateDetector = (detectorId, patch) => setAntiNuke((current) => ({
      ...current,
      detectors: {
        ...(current.detectors || {}),
        [detectorId]: { ...(current.detectors?.[detectorId] || protectionCatalog.defaults?.[detectorId] || {}), ...patch }
      }
    }));
    const protectionFeatures = [
      { label: 'Audit Log monitor', ok: antiNuke.enabled, detail: 'Executor identificado e registrado' },
      { label: 'Detectores modulares', ok: activeDetectors > 0, detail: `${activeDetectors}/${protectionCatalog.detectors?.length || 0} ativos` },
      { label: 'Recuperacao', ok: antiNuke.autoRestore && (antiNuke.backupChannels || antiNuke.backupRoles), detail: 'Canal, cargo e alteracoes criticas' },
      { label: 'Logs detalhados', ok: Boolean(antiNuke.logChannelId), detail: antiNuke.logChannelId || 'Defina um canal' },
      { label: 'Whitelists', ok: Boolean(antiNuke.whitelist || antiNuke.ignoredRoles || antiNuke.ignoredChannels), detail: 'Usuarios, cargos e canais' },
      { label: 'Quarentena', ok: Boolean(antiNuke.quarantineRoleId), detail: antiNuke.quarantineRoleId || 'Cargo opcional' }
    ];
    return (
      <div className="discord-section-grid">
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Protecao do servidor</h3>
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
              Ativar protecao do servidor
            </label>
            <label>
              Limite por minuto
              <input type="number" min="1" max="60" value={antiNuke.limitPerMinute} onChange={(event) => setAntiNuke((current) => ({ ...current, limitPerMinute: Number(event.target.value) }))} />
            </label>
            <label>
              Janela de tempo
              <input type="number" min="10" max="300" value={antiNuke.limitWindowSeconds} onChange={(event) => setAntiNuke((current) => ({ ...current, limitWindowSeconds: Number(event.target.value) }))} />
            </label>
            <label>
              Punicao automatica
              <select value={antiNuke.punishment} onChange={(event) => setAntiNuke((current) => ({ ...current, punishment: event.target.value }))}>
                <option value="warn">Somente avisar</option>
                <option value="remove_roles">Remover cargos perigosos</option>
                <option value="quarantine">Mover para quarentena</option>
                <option value="timeout">Aplicar timeout</option>
                <option value="ban">Banir usuario</option>
                <option value="kick">Expulsar usuario</option>
                <option value="none">Apenas alertar</option>
              </select>
            </label>
            <label>
              Duracao do timeout
              <input type="number" min="1" max="40320" value={antiNuke.timeoutMinutes} onChange={(event) => setAntiNuke((current) => ({ ...current, timeoutMinutes: Number(event.target.value) }))} />
            </label>
            <label>
              Cargo quarentena
              <input value={antiNuke.quarantineRoleId} onChange={(event) => setAntiNuke((current) => ({ ...current, quarantineRoleId: event.target.value }))} placeholder="Role ID" />
            </label>
            <label>
              Canal de logs
              <input value={antiNuke.logChannelId} onChange={(event) => setAntiNuke((current) => ({ ...current, logChannelId: event.target.value }))} placeholder="Channel ID" />
            </label>
            <label>
              Entradas em massa
              <input type="number" min="1" max="100" value={antiNuke.joinLimit} onChange={(event) => setAntiNuke((current) => ({ ...current, joinLimit: Number(event.target.value) }))} />
            </label>
            <label>
              Janela anti-raid
              <input type="number" min="5" max="300" value={antiNuke.joinWindowSeconds} onChange={(event) => setAntiNuke((current) => ({ ...current, joinWindowSeconds: Number(event.target.value) }))} />
            </label>
            <label>
              Idade minima da conta
              <input type="number" min="0" max="365" value={antiNuke.minAccountAgeDays} onChange={(event) => setAntiNuke((current) => ({ ...current, minAccountAgeDays: Number(event.target.value) }))} />
            </label>
            <label>
              Webhooks por minuto
              <input type="number" min="1" max="30" value={antiNuke.webhookLimitPerMinute} onChange={(event) => setAntiNuke((current) => ({ ...current, webhookLimitPerMinute: Number(event.target.value) }))} />
            </label>
            <label>
              Mensagens na janela
              <input type="number" min="2" max="50" value={antiNuke.messageLimit} onChange={(event) => setAntiNuke((current) => ({ ...current, messageLimit: Number(event.target.value) }))} />
            </label>
            <label>
              Janela anti-spam
              <input type="number" min="3" max="120" value={antiNuke.messageWindowSeconds} onChange={(event) => setAntiNuke((current) => ({ ...current, messageWindowSeconds: Number(event.target.value) }))} />
            </label>
            <label>
              Repeticoes permitidas
              <input type="number" min="2" max="20" value={antiNuke.duplicateMessageLimit} onChange={(event) => setAntiNuke((current) => ({ ...current, duplicateMessageLimit: Number(event.target.value) }))} />
            </label>
            <label>
              Mencoes por mensagem
              <input type="number" min="2" max="50" value={antiNuke.mentionLimit} onChange={(event) => setAntiNuke((current) => ({ ...current, mentionLimit: Number(event.target.value) }))} />
            </label>
            <label>
              Convites por minuto
              <input type="number" min="1" max="20" value={antiNuke.inviteLimitPerMinute} onChange={(event) => setAntiNuke((current) => ({ ...current, inviteLimitPerMinute: Number(event.target.value) }))} />
            </label>
            <label>
              Modo verificacao
              <select value={antiNuke.verificationMode} onChange={(event) => setAntiNuke((current) => ({ ...current, verificationMode: event.target.value }))}>
                <option value="low">Leve</option>
                <option value="medium">Medio</option>
                <option value="high">Forte</option>
              </select>
            </label>
            <label className="wide">
              Whitelist de usuarios confiaveis
              <textarea rows={3} value={antiNuke.whitelist} onChange={(event) => setAntiNuke((current) => ({ ...current, whitelist: event.target.value }))} placeholder="Um Discord ID por linha" />
            </label>
            <label className="wide">
              Cargos ignorados
              <textarea rows={3} value={antiNuke.ignoredRoles} onChange={(event) => setAntiNuke((current) => ({ ...current, ignoredRoles: event.target.value }))} placeholder="Um Role ID por linha" />
            </label>
            <label className="wide">
              Canais e categorias ignorados
              <textarea rows={3} value={antiNuke.ignoredChannels} onChange={(event) => setAntiNuke((current) => ({ ...current, ignoredChannels: event.target.value }))} placeholder="Um Channel/Category ID por linha" />
            </label>
            <label className="wide">
              Cargos para notificar
              <textarea rows={2} value={antiNuke.notifyRoleIds} onChange={(event) => setAntiNuke((current) => ({ ...current, notifyRoleIds: event.target.value }))} placeholder="Um Role ID por linha" />
            </label>
            <label className="wide">
              Mensagem de aviso
              <input value={antiNuke.warnMessage} onChange={(event) => setAntiNuke((current) => ({ ...current, warnMessage: event.target.value }))} />
            </label>
          </div>
          <div className="discord-toggle-grid">
            <label className="switch-line"><input type="checkbox" checked={antiNuke.autoLockdown} onChange={(event) => setAntiNuke((current) => ({ ...current, autoLockdown: event.target.checked }))} /> Lockdown automatico</label>
            <label className="switch-line"><input type="checkbox" checked={antiNuke.blockInviteSpam} onChange={(event) => setAntiNuke((current) => ({ ...current, blockInviteSpam: event.target.checked }))} /> Bloquear spam de convite</label>
            <label className="switch-line"><input type="checkbox" checked={antiNuke.blockMentionSpam} onChange={(event) => setAntiNuke((current) => ({ ...current, blockMentionSpam: event.target.checked }))} /> Bloquear mention spam</label>
            <label className="switch-line"><input type="checkbox" checked={antiNuke.backupChannels} onChange={(event) => setAntiNuke((current) => ({ ...current, backupChannels: event.target.checked }))} /> Backup de canais</label>
            <label className="switch-line"><input type="checkbox" checked={antiNuke.backupRoles} onChange={(event) => setAntiNuke((current) => ({ ...current, backupRoles: event.target.checked }))} /> Backup de cargos</label>
            <label className="switch-line"><input type="checkbox" checked={antiNuke.autoRestore} onChange={(event) => setAntiNuke((current) => ({ ...current, autoRestore: event.target.checked }))} /> Restaurar e reverter automaticamente</label>
          </div>
          <div className="protection-detector-stack">
            <div className="protection-detector-heading">
              <span><strong>Detectores individuais</strong><small>Cada camada tem limite, janela e castigo proprios.</small></span>
              <span className="protection-count">{activeDetectors} ativos</span>
            </div>
            {detectorGroups.map((group) => {
              const groupActive = group.detectors.filter((detector) => antiNuke.detectors?.[detector.id]?.enabled).length;
              return (
                <details className="protection-detector-group" key={group.id}>
                  <summary><span>{group.label}</span><small>{groupActive}/{group.detectors.length}</small></summary>
                  <div className="protection-detector-list">
                    {group.detectors.map((detector) => {
                      const detectorSettings = antiNuke.detectors?.[detector.id] || protectionCatalog.defaults?.[detector.id] || {};
                      const unavailable = detector.capability === 'unavailable-no-discord-ip';
                      return (
                        <article className={`protection-detector-row ${detectorSettings.enabled ? 'enabled' : ''}`} key={detector.id}>
                          <div className="protection-detector-name">
                            <label className="switch-line">
                              <input type="checkbox" disabled={unavailable} checked={Boolean(detectorSettings.enabled)} onChange={(event) => updateDetector(detector.id, { enabled: event.target.checked })} />
                              <span><strong>{detector.label}</strong><small>{detector.id} · {detector.capability}</small></span>
                            </label>
                          </div>
                          <div className="protection-detector-controls">
                            <label>Limite<input type="number" min="1" max="10000" value={detectorSettings.threshold || 1} onChange={(event) => updateDetector(detector.id, { threshold: Number(event.target.value) })} /></label>
                            <label>Janela (s)<input type="number" min="1" max="3600" value={detectorSettings.windowSeconds || 60} onChange={(event) => updateDetector(detector.id, { windowSeconds: Number(event.target.value) })} /></label>
                            <label>Castigo<select value={detectorSettings.punishment || 'none'} onChange={(event) => updateDetector(detector.id, { punishment: event.target.value })}>
                              <option value="warn">Avisar</option><option value="timeout">Timeout</option><option value="remove_roles">Tirar cargos</option><option value="quarantine">Quarentena</option><option value="kick">Expulsar</option><option value="ban">Banir</option><option value="none">So log</option>
                            </select></label>
                            {detector.deleteMessage && <label className="protection-delete"><input type="checkbox" checked={Boolean(detectorSettings.deleteMessage)} onChange={(event) => updateDetector(detector.id, { deleteMessage: event.target.checked })} /> Apagar</label>}
                          </div>
                          {protectionCatalog.limitations?.[detector.id] && <p>{protectionCatalog.limitations[detector.id]}</p>}
                        </article>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </div>
          <button className="primary-button" onClick={saveAntiNuke} disabled={loading === 'anti-nuke-save'}><Save size={17} /> {loading === 'anti-nuke-save' ? 'Ativando' : 'Salvar protecao no bot'}</button>
        </section>
        <section className="panel discord-tool-card">
          <div className="panel-title">
            <h3>Camadas ativas</h3>
            <Shield size={18} />
          </div>
          <div className="discord-check-grid">
            {protectionFeatures.map((item) => (
              <article className={item.ok ? 'ok' : 'warn'} key={item.label}>{item.ok ? <Check size={18} /> : <AlertTriangle size={18} />}<span><strong>{item.label}</strong><small>{item.detail}</small></span></article>
            ))}
          </div>
          <div className="discord-stat-grid">
            <Metric icon={AlertTriangle} label="Deteccoes" value={protectionStats.totals?.detections || 0} />
            <Metric icon={Ban} label="Acoes aplicadas" value={protectionStats.totals?.actions || 0} />
          </div>
          <div className="discord-list">
            {(protectionStats.events || []).slice(0, 8).map((event) => (
              <article className="discord-log-row" key={event.id}>
                <span className="discord-log-dot anti-nuke" />
                <span>
                  <strong>{event.metadata?.detectorName || event.detector_id}</strong>
                  <small>{event.action_taken} · {formatDate(event.created_at)}</small>
                </span>
              </article>
            ))}
            {(!protectionStats.events || protectionStats.events.length === 0) && <EmptyState icon={ScrollText} title="Nenhuma deteccao recente" />}
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
              <option value="anti-nuke">Protecao</option>
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

  function renderAddBotModal() {
    if (!showAddBotModal) return null;
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true">
        <form className="modal account-form" onSubmit={(event) => { event.preventDefault(); void addManagedBot(); }}>
          <div className="modal-header">
            <div>
              <p className="eyebrow">Discord multi-bot</p>
              <h3>Adicionar bot pelo token</h3>
            </div>
            <IconButton label="Fechar" type="button" onClick={closeAddBotModal}>
              <X size={18} />
            </IconButton>
          </div>
          <div className="notice subtle">Cole o token do bot aqui. Ele fica somente nesta sessao do painel.</div>
          <div className="form-grid">
            <label className="span-2">
              Token do bot
              <input
                autoFocus
                type="password"
                value={newBotForm.token}
                onChange={(event) => setNewBotForm((current) => ({ ...current, token: event.target.value }))}
                placeholder="Cole o token do bot"
              />
            </label>
            <label>
              ID do servidor
              <input
                value={newBotForm.guildId}
                onChange={(event) => setNewBotForm((current) => ({ ...current, guildId: event.target.value }))}
                placeholder="Opcional"
              />
            </label>
            <label>
              Nome no painel
              <input
                value={newBotForm.name}
                onChange={(event) => setNewBotForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Opcional"
              />
            </label>
          </div>
          <div className="modal-actions">
            <button className="ghost-button" type="button" onClick={closeAddBotModal}>Cancelar</button>
            <button className="primary-button" type="submit" disabled={loading === 'bot-add'}>
              <Plus size={17} />
              {loading === 'bot-add' ? 'Validando' : 'Adicionar bot'}
            </button>
          </div>
        </form>
      </div>
    );
  }

  const renderers = {
    overview: renderControlOverview,
    runtime: renderRuntimeControl,
    voice: renderVoiceControl,
    'profile-control': renderProfileControl,
    invite: renderInviteManager,
    webhook: renderWebhook,
    embed: renderEmbedBuilder,
    bot: renderBotManager,
    commands: renderCommandCenter,
    channels: renderChannels,
    roles: renderRoles,
    security: renderSecurityCenter,
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
          <>
            <button className="primary-button" type="button" onClick={openAddBotModal}>
              <Plus size={17} />
              Adicionar bot
            </button>
            <button className="ghost-button" type="button" onClick={loadBotStatus}>
              <RefreshCw size={17} />
              Atualizar bot
            </button>
          </>
        )}
      />
      {renderAddBotModal()}
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
