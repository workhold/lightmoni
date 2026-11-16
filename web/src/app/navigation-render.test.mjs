import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {I18nProvider} from '../shared/i18n';
import SidebarNavigation from './SidebarNavigation';

const render = role => renderToStaticMarkup(createElement(I18nProvider,null,createElement(MemoryRouter,null,createElement(SidebarNavigation,{pathname:'/clusters',role,collapsed:false}))));

test('cluster management is a first-class operations link before applications',()=>{
 const html=render('admin');
 assert.match(html,/集群管理/);
 assert.match(html,/镜像与仓库/);
 assert.ok(html.indexOf('href="/image-management"')<html.indexOf('href="/clusters"'));
 assert.ok(html.indexOf('href="/clusters"')<html.indexOf('href="/applications"'));
 assert.doesNotMatch(html,/href="\/private-images"/);
 assert.doesNotMatch(html,/href="\/image-sources"/);
});

test('members keep the host link but not admin-only cluster management',()=>{
 const html=render('member');
 assert.match(html,/href="\/machines"/);
 assert.doesNotMatch(html,/集群管理/);
 assert.doesNotMatch(html,/href="\/clusters"/);
});
