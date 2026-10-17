import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PublicApp from './PublicApp';
import './styles.css';
document.title = 'W3 Forge';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={new QueryClient()}>
    <BrowserRouter basename="/forge"><PublicApp/></BrowserRouter>
  </QueryClientProvider></React.StrictMode>
);
