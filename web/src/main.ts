import { mount } from 'svelte';
import './tokens.css';
import './fonts.css';
import './app.css';
import './theme.css';
import './library.css';
import App from './App.svelte';
import { loadAppearance, mountFontsCss } from './lib/appearance.svelte';
import { applySettings, loadSettings } from './lib/settings.svelte';

mountFontsCss();
applySettings(); // localStorage 캐시(설정·프리셋 메타)로 바로 그린 뒤, 서버 값을 받아 덮어쓴다
void loadSettings(); // 기다리지 않는다: 리더가 settingsReady 로 필요할 때 기다린다
void loadAppearance().catch(() => undefined); // 테마·글꼴 목록 — 실패해도 캐시로 그린 화면은 그대로
mount(App, { target: document.getElementById('app')! });
