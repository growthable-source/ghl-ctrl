import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('wizard-builder-root');

if (container) {
  const root = createRoot(container);
  root.render(<App />);
} else {
  // eslint-disable-next-line no-console
  console.error('Wizard builder root element not found.');
}
