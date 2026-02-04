module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
    ],
    testTimeout: 30000, // 30 seconds for integration tests
    transform: {
        '^.+\\.[tj]sx?$': 'ts-jest',
    },
    transformIgnorePatterns: [
        "node_modules/(?!(superjson|copy-anything|is-what)/)"
    ],
};
