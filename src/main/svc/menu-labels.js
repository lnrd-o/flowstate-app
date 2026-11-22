// Labels for the NATIVE application menu (macOS menu bar, accelerators everywhere). The renderer has its own i18n for the HTML bar.
const EN = {
  'menu.file': 'File', 'menu.newProject': 'New project...', 'menu.openFolder': 'Open folder...', 'menu.openRecent': 'Open recent',
  'menu.noRecent': 'No recent projects', 'menu.saveState': 'Save state', 'menu.revealProject': 'Show project in file manager',
  'menu.settings': 'Settings', 'menu.quit': 'Quit',
  'menu.edit': 'Edit', 'menu.undo': 'Undo', 'menu.redo': 'Redo', 'menu.cut': 'Cut', 'menu.copy': 'Copy', 'menu.paste': 'Paste',
  'menu.selectAll': 'Select all', 'menu.find': 'Find', 'menu.attachImage': 'Attach image...', 'menu.clearHistory': 'Clear history',
  'menu.view': 'View', 'menu.toggleSidebar': 'Toggle sidebar', 'menu.toggleArtifacts': 'Toggle artifacts panel', 'menu.tasks': 'Tasks',
  'menu.usage': 'Usage', 'menu.devMode': 'Developer mode', 'menu.theme': 'Theme', 'menu.themeDark': 'Dark', 'menu.themeLight': 'Light',
  'menu.themeGold': 'Gold', 'menu.zoomIn': 'Zoom in', 'menu.zoomOut': 'Zoom out', 'menu.zoomReset': 'Actual size',
  'menu.fullscreen': 'Toggle full screen', 'menu.devtools': 'Developer tools',
  'menu.help': 'Help', 'menu.shortcuts': 'Keyboard shortcuts', 'menu.docs': 'Documentation', 'menu.releases': 'Releases',
  'menu.report': 'Report an issue', 'menu.about': 'About FlowState',
};
const ES = {
  'menu.file': 'Archivo', 'menu.newProject': 'Nuevo proyecto...', 'menu.openFolder': 'Abrir carpeta...', 'menu.openRecent': 'Abrir reciente',
  'menu.noRecent': 'Sin proyectos recientes', 'menu.saveState': 'Guardar estado', 'menu.revealProject': 'Mostrar proyecto en el explorador',
  'menu.settings': 'Ajustes', 'menu.quit': 'Salir',
  'menu.edit': 'Edicion', 'menu.undo': 'Deshacer', 'menu.redo': 'Rehacer', 'menu.cut': 'Cortar', 'menu.copy': 'Copiar', 'menu.paste': 'Pegar',
  'menu.selectAll': 'Seleccionar todo', 'menu.find': 'Buscar', 'menu.attachImage': 'Adjuntar imagen...', 'menu.clearHistory': 'Borrar historial',
  'menu.view': 'Ver', 'menu.toggleSidebar': 'Mostrar u ocultar barra lateral', 'menu.toggleArtifacts': 'Mostrar u ocultar panel de artefactos',
  'menu.tasks': 'Tareas', 'menu.usage': 'Uso', 'menu.devMode': 'Modo desarrollador', 'menu.theme': 'Tema', 'menu.themeDark': 'Oscuro',
  'menu.themeLight': 'Claro', 'menu.themeGold': 'Dorado', 'menu.zoomIn': 'Acercar', 'menu.zoomOut': 'Alejar', 'menu.zoomReset': 'Tamano real',
  'menu.fullscreen': 'Pantalla completa', 'menu.devtools': 'Herramientas de desarrollo',
  'menu.help': 'Ayuda', 'menu.shortcuts': 'Atajos de teclado', 'menu.docs': 'Documentacion', 'menu.releases': 'Versiones',
  'menu.report': 'Informar de un problema', 'menu.about': 'Acerca de FlowState',
};
export const LABELS = Object.freeze({ en: Object.freeze(EN), es: Object.freeze(ES) });

/** Native-menu label for an i18n key (falls back to English, then to the key itself). */
export const labelFor = (lang, key) => LABELS[lang]?.[key] ?? EN[key] ?? key;
