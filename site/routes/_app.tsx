import { type PageProps } from "fresh";

export default function App({ Component, url }: PageProps) {
  const path = url.pathname;
  const isHome = path === "/";
  const isDocs = path === "/docs" || path === "/app-convention";

  return (
    <html lang="en">
      <head>
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon={JSON.stringify({
            token: "69eb3aa5f4874e21a287c7de86cfea48",
          })}
        ></script>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>pyr - Python without the ceremony</title>
        <meta
          name="description"
          content="A project manager that bootstraps its own runtime, manages your venv, and gets out of the way. Six commands. One honest lockfile."
        />
        <meta property="og:title" content="pyr — Python without the ceremony" />
        <meta
          property="og:description"
          content="A project manager that bootstraps its own runtime, manages your venv, and gets out of the way. Six commands. One honest lockfile."
        />
        <meta property="og:url" content="https://pyrun.dev" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://pyrun.dev/og.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="twitter:title"
          content="pyr — Python without the ceremony"
        />
        <meta
          name="twitter:description"
          content="A project manager that bootstraps its own runtime, manages your venv, and gets out of the way. Six commands. One honest lockfile."
        />
        <meta name="twitter:image" content="https://pyrun.dev/og.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <nav class="nav">
          {isHome ? (
            <span class="nav-logo">pyr</span>
          ) : (
            <a class="nav-logo" href="/">
              pyr
            </a>
          )}
          <div class="nav-right">
            {isDocs ? (
              <span class="nav-link nav-link-current">docs</span>
            ) : (
              <a class="nav-link" href="/docs">
                docs
              </a>
            )}
            <a
              class="nav-link"
              href="https://github.com/axiomlayer/pyr"
              target="_blank"
              rel="noopener"
            >
              github
            </a>
          </div>
        </nav>

        <Component />

        <footer class="footer">
          <span>pyrun.dev</span>
          <span>
            <a
              class="nav-link"
              href="https://jasencarroll.com"
              target="_blank"
              rel="noopener"
            >
              by jasencarroll
            </a>
          </span>
        </footer>
      </body>
    </html>
  );
}
