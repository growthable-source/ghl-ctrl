#!/usr/bin/env node
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const watch = args.includes('--watch');

const outdir = path.resolve(__dirname, '..', 'public', 'build');
if (!fs.existsSync(outdir)) {
  fs.mkdirSync(outdir, { recursive: true });
}

const contextOptions = {
  entryPoints: [path.resolve(__dirname, '..', 'src', 'admin', 'index.jsx')],
  bundle: true,
  outdir,
  entryNames: 'admin',
  format: 'esm',
  sourcemap: true,
  loader: {
    '.js': 'jsx',
    '.jsx': 'jsx',
    '.css': 'css',
    '.png': 'file',
    '.jpg': 'file',
    '.svg': 'file'
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  },
  target: ['es2018'],
  minify: process.env.NODE_ENV === 'production'
};

async function build() {
  try {
    if (watch) {
      const ctx = await esbuild.context(contextOptions);
      await ctx.watch();
      console.log('Watching admin builder source files...');
    } else {
      await esbuild.build(contextOptions);
      console.log('Admin builder built successfully.');
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

build();
