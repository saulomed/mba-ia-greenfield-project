import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { MailService } from '../../src/mail/mail.service';

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
}

export async function captureConfirmationToken(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const mailService = app.get(MailService);
  let capturedToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, t: string) => {
      capturedToken = t;
      return Promise.resolve();
    });
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password });
  return capturedToken;
}

export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<AuthTokens> {
  const token = await captureConfirmationToken(app, email, password);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token });
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password });
  const { access_token, refresh_token } = res.body as AuthTokens;
  return { access_token, refresh_token };
}
