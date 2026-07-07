import { DefaultSession, DefaultUser } from 'next-auth';
import { DefaultJWT } from 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: 'admin' | 'client';
      clientId: string | null;
      // When set, this session was minted by an admin viewing a client
      // dashboard. The banner + "Return to admin" flow reads this to know
      // which admin to restore.
      impersonatedBy?: { id: string; email: string } | null;
    } & DefaultSession['user'];
  }

  interface User extends DefaultUser {
    role: 'admin' | 'client';
    clientId: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    id: string;
    role: 'admin' | 'client';
    clientId: string | null;
    impersonatedBy?: { id: string; email: string } | null;
  }
}
