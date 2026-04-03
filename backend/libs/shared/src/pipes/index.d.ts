import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
export declare class StrictValidationPipe implements PipeTransform {
    transform(value: unknown, { metatype }: ArgumentMetadata): Promise<any>;
    private needsValidation;
}
