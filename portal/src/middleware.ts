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

    // Client trying to access admin, marketer or coach area — redirect to
    // dashboard. Also covers a coach/admin who is viewing a client (that
    // session's role is 'client'): they go back via the banner, not by URL.
    if ((pathname.startsWith('/admin') || pathname.startsWith('/marketer') || pathname.startsWith('/coach')) && role === 'client') {
      return NextResponse.redirect(new URL('/dashboard', req.url));
    }

    // Marketer has exactly one home: /marketer (admins may also open it)
    if ((pathname.startsWith('/admin') || pathname.startsWith('/dashboard') || pathname.startsWith('/coach')) && role === 'marketer') {
      return NextResponse.redirect(new URL('/marketer', req.url));
    }

    // Coach has exactly one home: /coach (admins may also open it). Client
    // dashboards are reached only through "View dashboard" on the board.
    if ((pathname.startsWith('/admin') || pathname.startsWith('/dashboard') || pathname.startsWith('/marketer')) && role === 'coach') {
      return NextResponse.redirect(new URL('/coach', req.url));
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
  matcher: ['/admin/:path*', '/dashboard/:path*', '/marketer/:path*', '/coach/:path*'],
};
