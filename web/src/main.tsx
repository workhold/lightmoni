import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {App} from './shared/ui';
import AppearanceProvider from './shared/appearance';
import Root from './app/App';
import './app/style.css';
import './app/theme.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppearanceProvider><App><BrowserRouter><Root/></BrowserRouter></App></AppearanceProvider></React.StrictMode>);
