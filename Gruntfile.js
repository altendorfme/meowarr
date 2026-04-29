const fs = require('fs');
const path = require('path');
const sass = require('sass');

module.exports = function (grunt) {
  grunt.initConfig({
    clean: {
      dist: ['public/dist'],
    },
    uglify: {
      options: {
        mangle: true,
        compress: { drop_console: false },
      },
      app: {
        files: {
          'public/dist/app.js': ['src/js/app.js'],
        },
      },
    },
    copy: {
      iconsFonts: {
        expand: true,
        cwd: 'node_modules/bootstrap-icons/font/fonts/',
        src: ['**/*'],
        dest: 'public/dist/fonts/',
      },
      bootstrapJs: {
        files: [
          { src: 'node_modules/bootstrap/dist/js/bootstrap.bundle.min.js', dest: 'public/dist/vendor/bootstrap.bundle.min.js' },
          { src: 'node_modules/bootstrap/dist/js/bootstrap.bundle.min.js.map', dest: 'public/dist/vendor/bootstrap.bundle.min.js.map' },
        ],
      },
      favicon: {
        files: [
          { src: 'public/favicon.svg', dest: 'public/dist/favicon.svg' },
        ],
      },
    },
    watch: {
      scss: { files: ['src/scss/**/*.scss'], tasks: ['sass'] },
      js: { files: ['src/js/**/*.js'], tasks: ['uglify'] },
    },
  });

  grunt.registerTask('sass', 'Compile SCSS via the modern Sass JS API', function () {
    const entry = 'src/scss/app.scss';
    const outFile = 'public/dist/app.css';
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const result = sass.compile(entry, {
      style: 'compressed',
      loadPaths: ['node_modules'],
      quietDeps: true,
      silenceDeprecations: ['import', 'global-builtin', 'color-functions'],
    });
    fs.writeFileSync(outFile, result.css);
    grunt.log.writeln(`>> ${outFile} (${result.css.length} bytes)`);
  });

  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-contrib-uglify');
  grunt.loadNpmTasks('grunt-contrib-copy');
  grunt.loadNpmTasks('grunt-contrib-watch');

  grunt.registerTask('build', ['clean:dist', 'sass', 'uglify', 'copy']);
  grunt.registerTask('default', ['build']);
};
