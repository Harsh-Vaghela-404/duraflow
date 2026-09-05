import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(defineConfig({
  title: "Duraflow",
  description: "Durable workflow engine with crash recovery and saga pattern",
  cleanUrls: true,
  themeConfig: {
    siteTitle: "Duraflow",
    nav: [
      { text: "Guide", link: "/" },
      { text: "Installation", link: "/installation" },
      { text: "Tutorial", link: "/tutorial" },
      { text: "Sagas", link: "/sagas" },
      { text: "API", link: "/api/overview" },
      { text: "Blog", link: "/blog/" },
    ],
    sidebar: [
      {
        text: "Getting Started",
        collapsed: false,
        items: [
          { text: "Introduction", link: "/" },
          { text: "Installation", link: "/installation" },
          { text: "Tutorial", link: "/tutorial" },
          { text: "Core Concepts", link: "/concepts" },
        ],
      },
      {
        text: "Features",
        collapsed: false,
        items: [{ text: "Sagas (Compensation)", link: "/sagas" }],
      },
      {
        text: "API Reference",
        collapsed: false,
        items: [
          { text: "Overview", link: "/api/overview" },
          { text: "SDK", link: "/api/sdk" },
          { text: "gRPC", link: "/api/grpc" },
          { text: "Database Schema", link: "/database" },
        ],
      },
      {
        text: "Blog",
        collapsed: false,
        items: [
          { text: "All posts", link: "/blog/" },
          {
            text: "Memoization Is All You Need... Until",
            link: "/blog/memoization-vs-replay",
          },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/your-org/duraflow" },
    ],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Duraflow",
    },
    search: {
      provider: "local",
    },
  },
  vite: {
    resolve: {
      alias: {
        "@": "/src",
      },
    },
  },
}));
