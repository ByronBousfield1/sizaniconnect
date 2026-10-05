import nodemailer from 'nodemailer';
import type { Logger } from './logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  readonly configured: boolean;
  send(message: EmailMessage): Promise<void>;
}

export class SmtpEmailSender implements EmailSender {
  readonly configured = true;
  private readonly transport;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

/**
 * Used when no SMTP server is configured. Outside production it prints the message body so links
 * can be followed during development; in production it records only that an email was due.
 */
export class LogEmailSender implements EmailSender {
  readonly configured = false;

  constructor(
    private readonly log: Logger,
    private readonly showBody: boolean,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    this.log.info({ to: message.to, subject: message.subject }, 'Email not sent: SMTP is not configured');
    if (this.showBody) this.log.info(`\n----- email to ${message.to} -----\n${message.text}\n-----`);
  }
}

export class MemoryEmailSender implements EmailSender {
  readonly configured = true;
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
