import type {Metadata} from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aviator History Analyzer & Live Tracker',
  description: 'Live round history, honest odds, CUSUM drift monitor, strategy tester, and randomness checks. Ingest via universal bookmarklet, CSV import, manual entry, or API.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
