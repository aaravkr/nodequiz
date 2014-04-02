
/**
 * GA Quiz
 * Authors: GP.
 * Version: 1.0
 * Release Date: XX-XXX-2014
 */

/**
 * Module dependencies.
 */

var express = require('express'),
    http = require('http'),
    path = require('path'),
    swig = require('swig'),
    mongoose = require('mongoose'),
    hash = require('./utils/pass').hash,
    config = require('./config/config'),
    mailer = require('./utils/mail');

var app = express();

/**
 * Database models.
 */

mongoose.connect(config.DB_MONGO_CONNECT_STRING);

var UserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    password: String,
    salt: String,
    hash: String,
    security_question: String,
    security_answer: String,
    activated: { type: Boolean, default: false },
    admin: { type: Boolean, default: false }
});

var User = mongoose.model(config.DB_AUTH_TABLE, UserSchema);

/**
 * Middlewares.
 */

app.configure(function () {
    app.use(express.logger('dev'));
    app.use(express.json());
    app.use(express.urlencoded());
    app.use(express.cookieParser('QuizJS'));
    app.use(express.session({ secret: config.MASTER_SALT }));
    //app.use(app.router);
    app.use(express.static(path.join(__dirname, 'public')));
    app.set('views', path.join(__dirname, 'views'));
    app.set('view engine', 'swig');
    swig.setDefaults({ autoescape: false});
    app.engine('.html', swig.renderFile);
});

// `last_user` cookie test/set middleware.
// Saves logged in username to cookie. This is used during reset password.
// If a user is resetting password for someone else, this cookie value
// is sent for shaming.
app.use(function (req, res, next) {
    //console.log('--> ', req.originalUrl);
    var cookie = req.cookies.last_user;
    if (cookie === undefined) {
        if (req.session.user) {
            //2-day cookie.
            res.cookie('last_user', req.session.user.username, { maxAge: 172800000, httpOnly: true });
            //console.log('cookie created successfully');
        }
    } else {
        //console.log('cookie exists already!', cookie);
    }
    next();
});

// Messaging middleware.
app.use(function (req, res, next) {
    var error = req.session.error,
        msg = req.session.success;
    delete req.session.error;
    delete req.session.success;
    res.locals.message = null;
    if (error) {
        res.locals.message = error;
        res.locals.message_type = 'danger';
    }
    if (msg) {
        res.locals.message = msg;
        res.locals.message_type = 'success';
    }
    //maybe set tab name here as well, which can be passed from other functions.
    next();
});

/**
 * Helper functions.
 */

/**
 * Custom 500 page handler.
 *
 * @param {Error} full error.
 * @param {Request} request.
 * @param {Response} response.
 * @param {Boolean} allow to move to next middleware.
 */
function errorHandler(err, req, res, next) {
    res.status(500);
    var error_data = { error: err, stacktrace: err.stack };
    if (req.session.error) {
        error_data.message = req.session.error;
    }
    res.render(config.TEMPL_500, error_data);
}

/**
 * Authenticates a user by looking up the database.
 *
 * @param {String} username.
 * @param {String} password.
 * @param {Function} callback.
 */

function authenticate(name, pass, fn) {
    if (!module.parent) console.log('authenticating %s:%s', name, pass);
    User.findOne({
        username: name
    }, function (err, user) {
        if (user) {
            if (err) return fn(new Error(config.ERR_AUTH_INVALID_USERNAME));
            hash(pass, user.salt, function (err, hash) {
                if (err) return fn(err);
                if (hash == user.hash) return fn(null, user);
                fn(new Error(config.ERR_AUTH_INVALID_PASSWORD));
            });
        } else {
            return fn(new Error(config.ERR_AUTH_INVALID_USERNAME));
        }
    });
}

/**
 * Checks if the username exists.
 * Returns a boolean value.
 *
 * @param {String} username.
 * @param {Function} callback.
 */

function isUsernameValid(name, fn) {
    User.findOne({
        username: name
    }, function (err, user) {
        if (user) {
            if (err) return fn(new Error(config.ERR_AUTH_INVALID_USERNAME));
            return fn(null, true);
        } else {
            return fn(null, false);
        }
    });
}

/**
 * Checks if user is logged in.
 * If yes, move to next middleware.
 * If no, redirect user to login page.
 *
 * @param {String} request.
 * @param {String} response.
 * @param {Boolean} allow to move to next middleware.
 */

function requiredAuthentication(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        req.session.error = config.ERR_AUTH_NOT_LOGGED_IN;
        res.redirect(config.URL_LOGIN);
    }
}

/**
 * Checks if username exists in the database.
 * If yes, move to next middleware.
 * If no, redirect user to signup page.
 * (Called during signup process.)
 *
 * @param {String} request.
 * @param {String} response.
 * @param {Boolean} allow to move to next middleware.
 */

function userExist(req, res, next) {
    User.count({
        username: req.body.username
    }, function (err, count) {
        if (count === 0) {
            next();
        } else {
            req.session.error = config.ERR_SIGNUP_ALREADY_EXISTS;
            res.render(config.TEMPL_LOGIN, { tab: 'signup' });
        }
    });
}

/**
 * Activates user by setting `activated` = `true` in DB docs.
 *
 * @param {String} username.
 * @param {Function} callback.
 */

function activateUser(name, fn) {
    //Better use a new instance because mongoose behaves
    //weirdly when doing an UPDATE on an existing instance.
    var User = mongoose.model(config.DB_AUTH_TABLE, UserSchema);
    User.findOne({
        username: name
    }, function (err, user) {
        if (user) {
            console.log('user found! proceeding to update...');
            User.update({ username: name, activated: false }, { activated: true }, { multi: false }, function(err, count) {
                if(err) { throw err; }
                console.log('DB UPDATED PHEW! count = ', count);
                return fn(null, count);
            });
        } else {
            return fn(new Error(config.ERR_ACTIVATION_INVALID_KEY));
        }
    });
}

/**
 * Resets user password and sends an email with the new password
 * to the user's registered email ID.
 *
 * @param {String} username.
 * @param {String} security question.
 * @param {String} security answer.
 * @param {String} domain that the app is running on.
 * @param {String} request's origin IP address.
 * @param {String} value of last_user cookie.
 * @param {Function} callback.
 */

function resetPassword(name, security_question, security_answer, domain, ip, user_cookie, fn) {
    //Better use a new instance because mongoose behaves
    //weirdly when doing an UPDATE on an existing instance.
    var User = mongoose.model(config.DB_AUTH_TABLE, UserSchema);
    User.findOne({
        username: name,
        security_question: security_question,
        security_answer: security_answer
    }, function (err, user) {
        if (user) {
            console.log('user found! proceeding to reset password...');
            console.log(user._id);
            var new_password = (Math.random() + 1).toString(32).slice(2);
            hash(new_password, function (err, salt, hash) {
                if (err) throw err;
                console.log('new password = ', new_password);
                User.update({ username: name }, { salt: salt, hash: hash }, { multi: false }, function(err, count) {
                    if(err) throw err;
                    console.log('DB UPDATED WITH NEW PASSWORD, PHEW! count = ', count);
                    mailer.sendNewPassword(domain, ip, user_cookie, name, new_password);
                    return fn(null, new_password);
                });
            });
        } else {
            return fn(new Error(config.ERR_RESET_INVALID_DETAILS));
        }
    });
}
/**
 * Routes
 */

app.get(config.URL_MAIN, function (req, res) {
    if (req.session.user) {
        res.send('Welcome ' + req.session.user.username + '<br>' + "<a href='/logout'>logout</a>");
    } else {
        res.render(config.TEMPL_LOGIN, { tab: 'login' });
    }
});

app.get(config.URL_SIGNUP, function (req, res) {
    console.log('in URL_SIGNUP GET NOW...');
    if (req.session.user) {
        res.redirect(config.URL_MAIN);
    } else {
        res.redirect('/#signup');
    }
});

app.post(config.URL_SIGNUP, userExist, function (req, res) {
    console.log(req.body);
    var username = req.body.username;
    var password = req.body.password;
    var password1 = req.body.password1;
    var security_question = req.body.security_question;
    var security_answer = req.body.security_answer;
    console.log('in URL_SIGNUP POST NOW...');
    console.log(username, '----', password, '----', password1);
    //TO-DO: validate all these^^^ fields first

    isUsernameValid(username, function (err, valid) {
        if (err) throw err;
        if (!valid) {
            hash(password, function (err, salt, hash) {
                if (err) throw err;
                var user = new User({
                    username: username,
                    salt: salt,
                    hash: hash,
                    security_question: security_question,
                    security_answer: security_answer
                }).save(function (err, newUser) {
                    if (err) throw err;
                    console.log('calling encrypt now...');

                    var encrypt = require('./utils/pass').encrypt;
                    encrypt(username, function (err, activate_key) {
                        if (err) throw err;
                        var domain = req.protocol + '://' + req.get('host');
                        mailer.sendActivationLink(domain, username, activate_key);
                        console.log('encrypted activation key - ', activate_key);
                    });

                    res.render(config.TEMPL_200, {
                        message_title: 'Done!',
                        message_1: 'We\'ve sent you an email with the activation link!',
                        message_2: 'Check your mailbox yo!'
                    });

                    /*authenticate(newUser.username, password, function (err, user) {
                        if(user) {
                            req.session.regenerate(function () {
                                req.session.user = user;
                                req.session.success = 'Authenticated as ' + user.username + ' click to <a href="/logout">logout</a>. ' + ' You may now access <a href="/restricted">/restricted</a>.';
                                res.redirect(config.URL_MAIN);
                            });
                        }
                    });*/
                });
            });
        } else {
            console.log('dei you\'re already registered');
            req.session.error = config.ERR_SIGNUP_ALREADY_EXISTS;
            res.redirect(config.URL_SIGNUP);
        }
    });
});

app.post(config.URL_FORGOT, function (req, res) {
    var username = req.body.username;
    var security_question = req.body.security_question;
    var security_answer = req.body.security_answer;
    console.log('in POST of /forgot now... for user - ', username);
    isUsernameValid(username, function (err, valid) {
        if (err) throw err;
        if (valid) {
            console.log('valid user alright. now to reset your password....');
            var domain = req.protocol + '://' + req.get('host');
            var ip = req.headers['x-forwarded-for'] ||
                        req.connection.remoteAddress ||
                        req.socket.remoteAddress ||
                        req.connection.socket.remoteAddress;
            var user_cookie = req.cookies.last_user;
            resetPassword(username, security_question, security_answer, domain, ip, user_cookie, function (err, new_password) {
                if (err && err.message == config.ERR_RESET_INVALID_DETAILS) {
                    req.session.error = err.message;
                    res.redirect(config.URL_FORGOT);
                } else if (err) {
                    throw err;
                }
                console.log('reset done in DB. new password = ', new_password);
                res.render(config.TEMPL_200, {
                        message_title: 'Done!',
                        message_1: 'We\'ve sent you an email with your new password!',
                        message_2: 'Check your mailbox yo!'
                    });
            });

        } else {
            req.session.error = config.ERR_RESET_INVALID_USERNAME;
            res.redirect(config.URL_FORGOT);
        }
    });
});

app.get(config.URL_FORGOT, function (req, res) {
    res.render(config.TEMPL_LOGIN, { tab: 'forgot' });
});

app.get(config.URL_LOGIN, function (req, res) {
     res.render(config.TEMPL_LOGIN, { tab: 'login' });
});

app.post(config.URL_LOGIN, function (req, res) {
    console.log('LOG IN POST METHOD!', req.body);
    authenticate(req.body.username, req.body.password, function (err, user) {
        if (user) {
            req.session.regenerate(function () {
                req.session.user = user;
                req.session.success = 'Authenticated as ' + user.username + ' click to <a href="/logout">logout</a>. ' +
                                      ' You may now access <a href="/restricted">/restricted</a>.';
                //res.redirect(config.URL_MAIN);
                res.redirect(config.URL_QUIZ_MAIN);
            });
        } else {
            req.session.error = 'Authentication failed, please check your username and password.';
            console.log('HEY! ', req.session.error);
            res.redirect(config.URL_LOGIN);
        }
    });
});

app.get('/activate/:activate_key', function (req, res) {
    console.log('in GET of /activate now...');
    var decrypt = require('./utils/pass').decrypt;
    decrypt(req.params.activate_key, function (err, username) {
        if (err) {
            req.session.error = '... but not really. Looks like your activation key is invalid.' +
                            'Either you\'re trying to break into someone else\'s account (which is really lame) ' +
                            'or.. nope. You\'re lame.';
            throw err;
        }
        console.log('decrypted username - ', username);
        activateUser(username, function (err, count) {
                if (err) {
                    console.log(err);
                    console.log('activation -> error caught in activateUser() function!');
                    req.session.error = 'User no longer exists!';
                    throw err;
                }
                console.log('activateUser - return value - ', count);
                if(count == 1){
                    res.render(config.TEMPL_200, {
                        message_title: 'Done!',
                        message_1: 'Your account has been activated!',
                        message_2: 'You can now login and start taking quizzes.'
                    });
                } else if (count == 0) {
                     res.render(config.TEMPL_200, {
                        message_title: 'WAITAMINIT!',
                        message_1: 'Your account has already been activated!',
                        message_2: 'Did you <a href="' + config.URL_FORGOT + '">forget</a> your password?'
                    });
                }//handle other cases, should I?
        });
    });
});

app.get(config.URL_LOGOUT, function (req, res) {
    req.session.destroy(function () {
        res.redirect(config.URL_MAIN);
    });
});

app.get('/profile', requiredAuthentication, function (req, res) {
    res.send('Profile page of '+ req.session.user.username +'<br>'+' click to <a href="/logout">logout</a>');
});

app.get(config.URL_QUIZ_MAIN, requiredAuthentication, function (req, res) {
    res.render(config.TEMPL_QUIZ_MAIN, {'username': req.session.user.username});
});

/**
 * Error handling.
 */

//Use Express' built-in 500 handler.
//app.use(express.errorHandler({ showStack: true, dumpExceptions: true }));

//Use our custom 500 handler.
app.use(errorHandler);

//404 handler.
app.use(function(req, res, next){
    res.status(404);
    res.render(config.TEMPL_400, { url: req.url });
    return;
});

process.on('uncaughtException', function(err) {
    logger.log('error', 'UNCAUGHT EXCEPTION', err.stack);
});

/**
 * Run the app!
 */

http.createServer(app).listen(config.APP_PORT, function () {
  console.log('NodeJS Express server listening on port [' + config.APP_PORT + ']');
});