// Project actions menu (sidebar kebab + chat header): rename, mode, auto-commit, remote control, clear history, remove.
import { t } from '../lib/i18n.js';
import { openMenu } from './menu.js';
import { isDev } from '../lib/store.js';

const MODES = ['default', 'acceptEdits', 'plan'];

export function openProjectMenu(anchor, projectId, { store, actions }) {
  const project = store.get().projects.find((x) => x.id === projectId);
  if (!project) return null;
  const remote = store.get().remote[project.id];
  const running = !!(store.get().chats[project.id] && store.get().chats[project.id].running);
  const dev = isDev(store.get());
  return openMenu(anchor, [
    { label: t('menu.rename'), onClick: () => actions.renameProject(project.id) },
    { sep: true },
    { heading: t('mode.label') },
    ...MODES.map((m) => ({ label: t((dev ? 'mode.' : 'mode.friendly.') + m), checked: project.mode === m, disabled: running, onClick: () => actions.updateProject(project.id, { mode: m }) })),
    { sep: true },
    { label: t('project.autoCommit'), checked: !!project.autoCommit, role: 'menuitemcheckbox', onClick: () => actions.updateProject(project.id, { autoCommit: !project.autoCommit }) },
    ...(dev ? [{ label: t('remote.label'), checked: !!(remote && remote.running), role: 'menuitemcheckbox', onClick: () => actions.toggleRemote(project.id) }] : []),
    { sep: true },
    { label: t('menu.projectSettings'), onClick: () => actions.openProjectSettings(project.id) },
    { label: t('menu.projectData'), onClick: () => actions.openProjectData(project.id) },
    { sep: true },
    { label: t('history.clear'), onClick: () => actions.clearHistory(project.id) },
    { label: t('menu.remove'), danger: true, onClick: () => actions.removeProject(project.id) },
  ], { label: t('menu.projectActions', { name: project.name }) });
}
