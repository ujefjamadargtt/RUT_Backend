'use strict';

/**
 * Joi Request Validation Middleware Factory
 *
 * @param {import('joi').Schema} schema   - Joi schema to validate against
 * @param {'body'|'query'|'params'} [property='body'] - Which part of the request to validate
 * @returns {Function} Express middleware
 *
 * Usage:
 *   router.post('/employees', authenticate, validate(createEmployeeSchema), handler)
 *   router.get('/employees', authenticate, validate(listQuerySchema, 'query'), handler)
 */
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const data = req[property];

    const { error, value } = schema.validate(data, {
      abortEarly: false,       // collect ALL errors before returning
      allowUnknown: false,     // reject unknown keys
      stripUnknown: true,      // strip keys not in schema from value
      convert: true,           // coerce types (string -> number, etc.)
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message.replace(/['"]/g, ''),
      }));

      return res.status(422).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed. Please check the submitted data.',
        errors,
      });
    }

    // Replace request property with validated (and possibly coerced) value
    req[property] = value;

    next();
  };
};

/**
 * Validates multiple request parts in a single middleware.
 * @param {{ body?: Schema, query?: Schema, params?: Schema }} schemas
 * @returns {Function} Express middleware
 *
 * Usage:
 *   router.put('/:id', authenticate, validateAll({ body: updateSchema, params: idParamSchema }), handler)
 */
const validateAll = (schemas) => {
  return (req, res, next) => {
    const allErrors = [];

    for (const [property, schema] of Object.entries(schemas)) {
      const data = req[property];

      const { error, value } = schema.validate(data, {
        abortEarly: false,
        allowUnknown: false,
        stripUnknown: true,
        convert: true,
      });

      if (error) {
        const fieldErrors = error.details.map((detail) => ({
          field: `${property}.${detail.path.join('.')}`,
          message: detail.message.replace(/['"]/g, ''),
        }));
        allErrors.push(...fieldErrors);
      } else {
        req[property] = value;
      }
    }

    if (allErrors.length > 0) {
      return res.status(422).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed. Please check the submitted data.',
        errors: allErrors,
      });
    }

    next();
  };
};

module.exports = { validate, validateAll };
