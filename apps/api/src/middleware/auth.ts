import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { config } from "../config.js";
import { HttpError } from "../utils/httpError.js";

export type AuthUser = {
  id: string;
  email: string;
  role: Role;
};

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export function signAuthToken(user: AuthUser) {
  return jwt.sign(user, config.jwtSecret, { expiresIn: "7d" });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing authorization token");
  }

  const token = header.slice("Bearer ".length);

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AuthUser;
    (req as AuthenticatedRequest).user = decoded;
    next();
  } catch {
    throw new HttpError(401, "Invalid or expired authorization token");
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;

    if (!user) {
      throw new HttpError(401, "Authentication required");
    }

    if (!roles.includes(user.role)) {
      throw new HttpError(403, "You do not have permission to access this resource");
    }

    next();
  };
}

export function getAuthUser(req: Request): AuthUser {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    throw new HttpError(401, "Authentication required");
  }

  return user;
}
