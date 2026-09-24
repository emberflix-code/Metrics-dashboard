import { DefaultSession, DefaultUser } from 'next-auth';
import { DefaultJWT } from 'next-auth/jwt';

// `marketer`: agency marketing specialist — sees every active client at
// once under /marketer (see src/lib/marketerAuth.ts). Admins can open the
// marketer area too; clients cannot.
export type UserRole = 'admin' | 'client' | 'marketer';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      clientId: string | null;
      // When set, this session was minted by an admin viewing a client
      // dashboard. The banner + "Return to admin" flow reads this to know
      // which admin to restore.
      impersonatedBy?: { id: string; email: string } | null;
    } & DefaultSession['user'];
  }

  interface User extends DefaultUser {
    role: UserRole;
    clientId: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    id: string;
    role: UserRole;
    clientId: string | null;
    impersonatedBy?: { id: string; email: string } | null;
  }
}
