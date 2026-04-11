import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

export default withAuth(
  function middleware(req) {
    const { token } = req.nextauth;
    const { pathname } = req.nextUrl;

    // Admin trying to access client area — redirect to admin
    if (pathname.startsWith('/dashboard') && token?.role === 'admin') {
      return NextResponse.redirect(new URL('/admin', req.url));
    }

    // Client trying to access admin area — redirect to dashboard
    if (pathname.startsWith('/admin') && token?.role === 'client') {
      return NextResponse.redirect(new URL('/dashboard', req.url));
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      // Only allow through if a valid session exists
      authorized: ({ token }) => !!token,
    },
  }
);

// Protect these routes — everything else (login, api/auth) is public
export const config = {
  matcher: ['/admin/:path*', '/dashboard/:path*'],
};
