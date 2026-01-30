const Joi = require('joi');

const validate = (schema) => {
    return (req, res, next) => {
        const { error } = schema.validate(req.body);
        if (error) {
            return res.status(400).json({ message: error.details[0].message });
        }
        next();
    };
};

const registerSchema = Joi.object({
    name: Joi.string().min(3).required().messages({'string.min': 'Nama minimal 3 huruf'}),
    email: Joi.string().email().required().messages({'string.email': 'Format email salah'}),
    password: Joi.string().min(6).required().messages({'string.min': 'Password minimal 6 karakter'}),
    phone_number: Joi.string().pattern(/^[0-9]+$/).min(10).required(),
    role: Joi.string().valid('patient', 'doctor').default('patient')
});

const loginSchema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
});

module.exports = { validate, registerSchema, loginSchema };