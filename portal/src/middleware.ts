import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

export default withAuth(
  function middleware(req) {
    const { token } = req.nextauth;
    const { pathname } = req.nextUrl;
    const role = token?.role;

    // Admin trying to access client area — redirect to admin
    if (pathname.startsWith('/dashboard') && role === 'admin') {
      return NextResponse.redirect(new URL('/admin', req.url));
    }

    // Client trying to access admin or marketer area — redirect to dashboard
    if ((pathname.startsWith('/admin') || pathname.startsWith('/marketer')) && role === 'client') {
      return NextResponse.redirect(new URL('/dashboard', req.url));
    }

    // Marketer has exactly one home: /marketer (admins may also open it)
    if ((pathname.startsWith('/admin') || pathname.startsWith('/dashboard')) && role === 'marketer') {
      return NextResponse.redirect(new URL('/marketer', req.url));
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
  matcher: ['/admin/:path*', '/dashboard/:path*', '/marketer/:path*'],
};
