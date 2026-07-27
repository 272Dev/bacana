import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './AppNexus.jsx';
import './stylesNexus.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
