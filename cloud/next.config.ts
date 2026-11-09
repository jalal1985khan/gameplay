import type {NextConfig} from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        {key: 'X-Frame-Options', value: 'DENY'},
        {key: 'Referrer-Policy', value: 'same-origin'},
        {key: 'X-Content-Type-Options', value: 'nosniff'},
      ],
    }];
  },
};
export default config;
