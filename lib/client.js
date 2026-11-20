// dsh-simple-notify — 浏览器半身
//
// 写法完全对齐 billion-context（本机唯一可读的、真正在用的第三方插件）：
//   1. t = ctx.locale.bind(NS)，在 apply() 里取，组件闭包捕获，不走 props
//   2. slots.register 只写 { name, id, order, label, locale }，没有 children、没有 inject
//   3. 组件无参，自己 useState / useEffect 管状态
//
// 教训记在全局 AGENTS.md 的 G24。

window.__ModuleLoader__.load({
  id: 'dsh-simple-notify',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const h = react.createElement;
    const useEffect = react.useEffect;
    const useState = react.useState;

    const NS = 'dsh-simple-notify';
    const BRIDGE = '/api/dsh-simple-notify-settings';

    // 只需要 slots 和 locale。settings.section 的声明方在 0.2.x 是
    // @deepseek-ai/dsh-client-ui-settings-general，但第三方插件不用显式 inject 它。
    const inject = ['slots', 'locale'];

    const zh = {
      title: '气泡提醒',
      description: 'DSH 停下来等你说话时，在窗口角上弹一个提醒。改动立即生效，不用重启。',
      sound: '播放声音',
      soundHint: '弹出提醒时播放系统的提示音。',
      fullscreenNotify: '运行全屏程序时提示',
      fullscreenNotifyHint: '你正在全屏看视频或玩游戏时，也弹出提醒。',
      suppressWhenForeground: '在前台时不提示',
      suppressWhenForegroundHint: 'DSH 窗口本来就是活动窗口时不打扰你。',
      showQuestions: '需要用户做出选择时提示',
      showQuestionsHint: '我停下来等你点选项时，单独弹一个提醒。',
      loading: '读取中…',
      loadFailed: '读取设置失败',
      saving: '保存中…',
      saveFailed: '保存失败',
    };

    const en = {
      title: 'Toast notices',
      description: 'Shows a notice when DSH stops and waits for you. Changes apply immediately.',
      sound: 'Play a sound',
      soundHint: 'Play the system notification chime.',
      fullscreenNotify: 'Notify while fullscreen',
      fullscreenNotifyHint: 'Also show notices while a fullscreen app is in front.',
      suppressWhenForeground: 'Stay quiet in foreground',
      suppressWhenForegroundHint: 'Do not interrupt when the DSH window is already active.',
      showQuestions: 'Notify when a choice is needed',
      showQuestionsHint: 'Remind me when the assistant stops and waits for you to pick an option.',
      loading: 'Loading…',
      loadFailed: 'Failed to read settings',
      saving: 'Saving…',
      saveFailed: 'Save failed',
    };

    // 顺序就是界面上的顺序。
    const FIELDS = [
      ['sound', 'boolean'],
      ['fullscreenNotify', 'boolean'],
      ['suppressWhenForeground', 'boolean'],
      ['showQuestions', 'boolean'],
    ];

    function request(path, init) {
      return fetch(BRIDGE + path, Object.assign({
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }, init || {})).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }

    function optionLabel(key, value) {
      return key + value.charAt(0).toUpperCase() + value.slice(1);
    }

    // ---- 开关样式 ----

    function switchStyle(on, disabled) {
      return {
        position: 'relative',
        display: 'inline-block',
        width: 38,
        height: 22,
        borderRadius: 11,
        flex: '0 0 auto',
        transition: 'background 0.15s',
        background: on ? '#2f7cf6' : 'rgba(128,128,128,0.35)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
      };
    }

    function knobStyle(on) {
      return {
        position: 'absolute',
        top: 3,
        left: on ? 19 : 3,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.15s',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
      };
    }

    function Switch(props) {
      const on = props.checked === true;
      const disabled = props.disabled === true;
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        disabled: disabled,
        onClick: function () { if (!disabled) props.onChange(!on); },
        style: Object.assign(switchStyle(on, disabled), {
          border: 'none',
          padding: 0,
          outline: 'none',
        }),
      }, [h('span', { key: 'k', style: knobStyle(on) })]);
    }

    // ---- 面板组件：无参，闭包捕获 t ----

    function makeNotifyCard(t) {
      return function NotifyCard() {
        const stateHook = useState({ status: 'loading', data: null, error: null });
        const state = stateHook[0];
        const setState = stateHook[1];

        useEffect(function () {
          let cancelled = false;
          request('/describe', { method: 'GET' })
            .then(function (data) {
              if (cancelled) return;
              setState({ status: 'ready', data: data, error: null });
            })
            .catch(function (err) {
              if (cancelled) return;
              setState({ status: 'error', data: null, error: String(err && err.message || err) });
            });
          return function () { cancelled = true; };
        }, []);

        function write(field, value) {
          const patch = {};
          patch[field] = value;
          setState(function (prev) {
            return { status: 'saving', data: prev.data, error: null };
          });
          request('/mutate', { method: 'POST', body: JSON.stringify(patch) })
            .then(function (data) {
              setState({ status: 'ready', data: data, error: null });
            })
            .catch(function (err) {
              setState(function (prev) {
                return { status: 'error', data: prev.data, error: String(err && err.message || err) };
              });
            });
        }

        if (state.status === 'loading') {
          return h('div', { style: { padding: '12px 0', opacity: 0.6, fontSize: 13 } }, t('loading'));
        }
        if (state.data === null) {
          return h('div', { style: { padding: '12px 0', color: '#d93f0b', fontSize: 13 } },
            t('loadFailed') + '：' + String(state.error || ''));
        }

        const data = state.data;
        const values = data.values || {};
        const defaults = data.defaults || {};
        const busy = state.status === 'saving';

        const rows = FIELDS.map(function (field) {
          const key = field[0];
          const kind = field[1];
          const current = values[key];
          const fallback = defaults[key];
          const effective = current === undefined ? fallback : current;

          let control;
          if (kind === 'boolean') {
            control = h(Switch, {
              key: 'c',
              checked: effective === true,
              disabled: busy,
              onChange: function (next) { write(key, next); },
            });
          } else {
            const opts = field[2];
            control = h('div', {
              key: 'c',
              style: { display: 'inline-flex', gap: 6, flex: '0 0 auto' },
            }, opts.map(function (opt) {
              const on = effective === opt;
              return h('button', {
                key: opt,
                type: 'button',
                disabled: busy,
                onClick: function () { if (!on) write(key, opt); },
                style: {
                  fontSize: 12,
                  lineHeight: '20px',
                  padding: '0 10px',
                  borderRadius: 10,
                  border: '1px solid ' + (on ? '#2f7cf6' : 'rgba(128,128,128,0.35)'),
                  background: on ? 'rgba(47,124,246,0.14)' : 'transparent',
                  color: 'inherit',
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.5 : 1,
                },
              }, t(optionLabel(key, opt)));
            }));
          }

          return h('div', {
            key: key,
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 16, padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,0.18)',
            },
          }, [
            h('div', { key: 'left', style: { flex: '1 1 auto', minWidth: 0 } }, [
              h('div', { key: 'n', style: { fontSize: 13, fontWeight: 600 } }, t(key)),
              h('div', { key: 'h', style: { fontSize: 12, opacity: 0.6, marginTop: 2 } }, t(key + 'Hint')),
            ]),
            h('div', { key: 'right', style: { flex: '0 0 auto' } }, control),
          ]);
        });

        return h('div', { style: { padding: '4px 0' } }, [
          h('div', { key: 'd', style: { fontSize: 12, opacity: 0.7, marginBottom: 12 } }, t('description')),
          ...rows,
          state.error !== null
            ? h('div', { key: 'e', style: { marginTop: 10, fontSize: 12, color: '#d93f0b' } },
                t('saveFailed') + '：' + String(state.error))
            : null,
        ]);
      };
    }

    // ---- 挂载 ----

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'simple-notify: dictionaries');

      const t = ctx.locale.bind(NS);
      const NotifyCard = makeNotifyCard(t);

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'simple-notify',
          order: 100,
          label: function () { return t('title'); },
          locale: NS,
        }, NotifyCard);
      });
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
