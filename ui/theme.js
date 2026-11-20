// Only core's theme snapshot can set colors. No styles from terminal settings.
const colors=['primary','secondary','accent','positive','negative','info','warning','dark','dark-page'];

export function applyCoreTheme(theme) {
  if(!theme || typeof theme!=='object')return;
  window.Quasar.Dark.set(theme.dark===true);
  document.body.dataset.theme=typeof theme.name==='string'?theme.name:'';
  document.body.classList.toggle('gradient-bg',theme.gradient===true);
  for(const name of colors){
    const value=theme.colors?.[name];
    if(typeof value==='string' && value.length<=128 && CSS.supports('color',value))document.body.style.setProperty(`--q-${name}`,value);
    else document.body.style.removeProperty(`--q-${name}`);
  }
}
