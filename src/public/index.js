// Carregador fixo do plugin. O dashboard manda o navegador guardar este arquivo por um ano, em
// um endereço que não muda com a versão do plugin. Por isso, ele não contém a aplicação: só
// descobre pelo manifesto qual é a versão atual. MUDE ESTE ARQUIVO O MÍNIMO POSSÍVEL: navegadores
// podem continuar usando esta cópia. O formato do manifesto e os nomes globais são um contrato.
const ASSETS = '/api/tlog_replay/assets';

function createLoader(http) {
  let manifest = null;
  const scripts = {};

  const getManifest = () => {
    if (!manifest) {
      manifest = http.get(`${ASSETS}/manifest`).catch((error) => {
        manifest = null;
        throw error;
      });
    }
    return manifest;
  };

  return (name, globalName) => {
    if (!scripts[name]) {
      scripts[name] = getManifest().then(
        (files) =>
          new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = http.basePath.prepend(`${ASSETS}/${files[name]}`);
            script.onload = () => resolve(window[globalName]);
            script.onerror = () => {
              delete scripts[name];
              reject(new Error(`Não foi possível carregar ${name}.`));
            };
            document.head.append(script);
          })
      );
    }
    return scripts[name];
  };
}

class TlogReplayLoader {
  setup(core) {
    const load = createLoader(core.http);
    this.load = load;
    core.application.register({
      id: 'tlogReplay',
      title: 'Session Replay',
      order: 9050,
      euiIconType: 'videoPlayer',
      // Ordem entre "Security operations" (400) e "Cloud security" (500) do Wazuh.
      category: {
        id: 'tlog-session-recording',
        label: 'Session recording',
        euiIconType: 'videoPlayer',
        order: 450,
      },
      mount: async (params) => {
        try {
          const [coreStart] = await core.getStartServices();
          const app = await load('app', '__tlogReplayApp');
          return app.mount(coreStart, params);
        } catch (error) {
          params.element.textContent = `Não foi possível abrir o Session Replay: ${error.message}`;
          return () => {
            params.element.textContent = '';
          };
        }
      },
    });
    return {};
  }

  start(core) {
    // Não bloqueia o dashboard. Na tela de login não há sessão para buscar os arquivos.
    const { pathname } = window.location;
    if (!pathname.endsWith('/app/login') && !core.http.anonymousPaths?.isAnonymous(pathname)) {
      this.load('menu', '__tlogReplayMenu')
        .then((menu) => menu.installAgentMenu(core.application))
        .catch(() => {
          // Sem o item do menu, o app continua acessível pelo menu lateral.
        });
    }
    return {};
  }

  stop() {}
}

// É assim que o OpenSearch Dashboards descobre o módulo público de um plugin.
window.__osdBundles__.define(
  'plugin/tlogReplay/public',
  () => ({ plugin: () => new TlogReplayLoader() }),
  'tlogReplay'
);
