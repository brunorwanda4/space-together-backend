import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class PassportJswAuthGuard extends AuthGuard('jwt'){}