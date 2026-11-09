import { Injectable, CanActivate } from '@nestjs/common';
/** Explicit extension point for external OIDC identity. Currently permissive. */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
