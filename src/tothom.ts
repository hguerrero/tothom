import * as vscode from 'vscode';

import * as utils from './utils';
import * as terminal from './terminal';
import { engine } from './engine';
import { slugify } from './slugify';

const CONFIGURATION_ROOT = 'tothom';
const WEBVIEW_PANEL_TYPE = 'tothom';

const originalHeadingOpen = engine.renderer.rules.heading_open;

export class Tothom {
  private _config: vscode.WorkspaceConfiguration;
  private _views: Map<vscode.Uri, vscode.WebviewPanel>;
  private _slugCount = new Map<string, number>();

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._config = vscode.workspace.getConfiguration(CONFIGURATION_ROOT);
    this._views = new Map<vscode.Uri, vscode.WebviewPanel>;
  }

  // commands

  openPreview = (uri: vscode.Uri): vscode.Webview | undefined => {
    const resource = utils.resourceFromUri(uri);

    let panel = this._views.get(resource);
    let webview: vscode.Webview | undefined = undefined;

    if (!panel) {
      const title = `Preview: ${utils.resourceName(resource)}`;

      var localResourceRoots = [this._extensionUri];
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]) {
        localResourceRoots.push(vscode.workspace.workspaceFolders[0].uri);
      }

      panel = vscode.window.createWebviewPanel(WEBVIEW_PANEL_TYPE, title, vscode.ViewColumn.Active, {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this._extensionUri,
        ]
      });
      panel.onDidDispose(() => this._views.delete(resource));

      webview = panel.webview;
      webview.onDidReceiveMessage(this.handleEvent);

      this._views.set(resource, panel);
    }

    this.updatePreview(uri);
    panel.reveal(0);

    return webview;
  };

  updatePreview = (uri: any): vscode.Webview | undefined => {
    const resource = utils.resourceFromUri(uri);

    let webview = this._views.get(resource)?.webview;
    if (!webview) {
      return undefined;
    }

    engine.renderer.rules.heading_open = this.headingOpen;
    this._slugCount.clear();

    const content = utils.readFileContent(resource);
    const htmlContent = this.renderHtmlContent(webview, resource, engine.render(content));
    webview.html = htmlContent;

    return webview;
  };

  reloadConfig = () => this._config = vscode.workspace.getConfiguration(CONFIGURATION_ROOT);

  // private methods

  private mediaFilePath = (webview: vscode.Webview, filePath: string): vscode.Uri => {
    return webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', filePath));
  };

  private sanitizeHtmlLocalPaths = (webview: vscode.Webview, uri: vscode.Uri, htmlContent: string): string => {
    const uriBasePath = vscode.Uri.file(utils.resourceDir(uri)).path;
    return htmlContent.replace(/<img(.+)src="([^"]+)"/g, (_: string, attrs: string, src: string): string => {
      const newSrc = src.startsWith('.') ? webview.asWebviewUri(vscode.Uri.file(uriBasePath + '/' + src)) : src;
      return `<img${attrs}src="${newSrc}"`;
    });
  };

  private renderHtmlContent = (webview: vscode.Webview, uri: vscode.Uri, htmlContent: string): string => {
    const cspSrc = webview.cspSource;
    const nonce = utils.getNonce();
    const baseHref = utils.resourceDir(uri);
    const baseTag = `<base href="${baseHref}${baseHref.endsWith('/') ? '' : '/'}"/>`;
    const sanitizedHtmlContent = this.sanitizeHtmlLocalPaths(webview, uri, htmlContent);

    let colorScheme: string = "";
    switch (this._config.get('colorScheme')) {
      case "light":
        colorScheme = `tothom-light`;
        break;
      case "dark":
        colorScheme = `tothom-dark`;
        break;
      default:
        colorScheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? `tothom-dark` : `tothom-light`;
        break;
    }

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: https: http: blob: ${cspSrc}; media-src vscode-resource: https: data:; script-src 'nonce-${nonce}' https:; style-src 'unsafe-inline' ${cspSrc} https: data:; font-src ${cspSrc} https: data:; object-src 'none';"/>
      <title>Tothom Markdown Preview</title>
      <link rel="stylesheet" href="${this.mediaFilePath(webview, 'tothom.css')}"/>
      <link rel="stylesheet" href="${this.mediaFilePath(webview, 'github-markdown.css')}"/>
      <link rel="stylesheet" href="${this.mediaFilePath(webview, 'highlight-js.css')}"/>
      ${baseTag}
      <script defer="true" src="https://use.fontawesome.com/releases/v5.3.1/js/all.js"></script>
    </head>
    <body class="tothom-body ${colorScheme}" data-uri="${uri}">
      <div class="tothom-content">
        ${sanitizedHtmlContent}
      </div>
      <script nonce="${nonce}" src="${this.mediaFilePath(webview, 'main.js')}"/>
    </body>
    </html>`;
  };

  private handleEvent = (event: any) => {
    switch (event.command) {
      case 'link':
        if (event.text) {
          const parsedUrl = utils.parseUrl(event.text, true);
		      const query = parsedUrl.query;
          const uri = vscode.Uri.parse(query.uri);
          this.runInTerminal(query.code, uri);
        }
        return;
    }
  };

  private runInTerminal = (encodedCommand: string, uri: vscode.Uri) => {
    const term = terminal.findOrCreateTerminal(uri.toString());
    let command = terminal.decodeTerminalCommand(encodedCommand);

    if (this._config.get('bracketedPasteMode')) {
      command = `\x1b[200~${command}\x1b[201~`;
    }

    term.sendText(command, true);

    term.show();
  };

  private headingOpen = (tokens: any[], idx: number, options: Object, env: Object, self: any) => {
    const raw = tokens[idx + 1].content;
    let slug = slugify(raw, { env });

    let lastCount = this._slugCount.get(slug);
    if (lastCount) {
      lastCount++;
      this._slugCount.set(slug, lastCount);
      slug += '-' + lastCount;
    } else {
      this._slugCount.set(slug, 0);
    }

    tokens[idx].attrs = [...(tokens[idx].attrs || []), ["id", slug]];

    if (originalHeadingOpen) {
      return originalHeadingOpen(tokens, idx, options, env, self);
    } else {
      return self.renderToken(tokens, idx, options);
    }
  };
}
