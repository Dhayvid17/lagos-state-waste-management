import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

@Injectable()
export class StrictValidationPipe implements PipeTransform {
  async transform(value: unknown, { metatype }: ArgumentMetadata) {
    if (!metatype || !this.needsValidation(metatype)) return value;

    const object = plainToInstance(metatype, value);
    const errors = await validate(object, {
      whitelist: true, // Strip unknown properties
      forbidNonWhitelisted: true, // Throw if unknown properties sent
      transform: true,
    });

    if (errors.length > 0) {
      const messages = errors.map((e) => Object.values(e.constraints ?? {}).join(', '));
      throw new BadRequestException(messages);
    }

    return object;
  }

  private needsValidation(metatype: Function): boolean {
    const primitives: Function[] = [String, Boolean, Number, Array, Object];
    return !primitives.includes(metatype);
  }
}
